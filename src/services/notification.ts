import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { createNotification } from './database';
import type { CallSummary } from './claude';
import { getTwilioClient } from './twilioClient';

// Transcript line for display (caller or assistant)
export type TranscriptLine = { role: string; content: string };

// Call log shape needed for formatting (from DB); transcripts optional for fallback path
type CallLogForNotification = {
  id: string;
  fromNumber: string;
  callerName: string | null;
  company: string | null;
  reasonForCall: string | null;
  urgency: string | null;
  callbackWindow: string | null;
  promisedActions: string | null;
  confidenceScore: number | null;
  summary: string | null;
  transcripts?: Array<{ role: string; content: string }>;
};

// ── Format Summary Message ───────────────────────────

/** Strip echo: caller lines that match or are contained in the previous agent line (agent voice picked up as "caller"). */
function filterEchoFromTranscript(parts: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const text = (p.content || '').trim();
    if (p.role === 'caller' && text && i > 0) {
      const prev = parts[i - 1];
      const callerLower = text.toLowerCase();
      if (prev.role === 'assistant') {
        const prevText = (prev.content || '').trim().toLowerCase();
        const isEcho =
          prevText === callerLower ||
          prevText.includes(callerLower) ||
          callerLower.includes(prevText) ||
          (callerLower.length >= 5 && prevText.includes(callerLower.slice(0, Math.min(15, callerLower.length))));
        if (isEcho) continue;
      }
      const lastAgent = out.slice().reverse().find((x) => x.role === 'assistant');
      if (lastAgent) {
        const lastAgentLower = (lastAgent.content || '').trim().toLowerCase();
        if (lastAgentLower && (lastAgentLower === callerLower || lastAgentLower.includes(callerLower) || callerLower.includes(lastAgentLower)))
          continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** Format transcript parts as line-by-line "Caller: ..." / "Agent: ..." (echo filtered out). */
function formatTranscriptLines(parts: TranscriptLine[]): string {
  if (!parts.length) return '';
  const filtered = filterEchoFromTranscript(parts);
  return filtered
    .map((p) => {
      const label = p.role === 'caller' ? 'Caller' : 'Agent';
      const text = (p.content || '').trim().replace(/\n/g, ' ');
      return text ? `${label}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Prefer one message block: show summary; only add reason if it adds info (short tagline vs longer summary). */
function dedupeReasonAndSummary(reason: string | null, summary: string | null): string {
  if (!summary?.trim()) return reason?.trim() ?? '';
  if (!reason?.trim()) return summary.trim();
  const r = reason.trim();
  const s = summary.trim();
  // Same or reason is just the start of summary → show only summary
  if (r === s || s.startsWith(r) || r.length > 0 && s.toLowerCase().includes(r.toLowerCase().slice(0, 40))) {
    return s;
  }
  // Reason is a short one-liner and summary is longer narrative → show summary only
  if (r.length < 80 && s.length > r.length + 30) return s;
  // Otherwise show summary (main content); reason often duplicates
  return s;
}

function formatSummaryMessage(
  summary: CallSummary,
  _callLogId: string,
  callerNumber: string,
  transcriptParts?: TranscriptLine[]
): string {
  const urgencyEmoji =
    summary.urgency === 'high' ? '🔴' : summary.urgency === 'medium' ? '🟡' : '🟢';
  const message = dedupeReasonAndSummary(summary.reason_for_call, summary.summary);

  const sentimentLabel = summary.sentiment && summary.sentiment !== 'neutral'
    ? ` | Tone: ${summary.sentiment}`
    : '';

  const lines = [
    `📞 Missed Call`,
    ``,
    `From: ${callerNumber}${summary.caller_name ? ` (${summary.caller_name})` : ''}`,
    summary.company ? `Company: ${summary.company}` : null,
    ``,
    `${urgencyEmoji} ${summary.urgency.toUpperCase()}${sentimentLabel}`,
    ``,
    message ? `Message: ${message}` : null,
    ``,
    summary.callback_window ? `Callback: ${summary.callback_window}` : null,
    summary.promised_actions.length > 0
      ? `Actions: ${summary.promised_actions.join('; ')}`
      : null,
  ];

  const transcriptBlock = transcriptParts?.length
    ? formatTranscriptLines(transcriptParts)
    : '';
  if (transcriptBlock) {
    lines.push(``, `Transcript:`, transcriptBlock);
  }

  return lines.filter(Boolean).join('\n');
}

function formatSummaryFromCallLog(callLog: CallLogForNotification): string {
  const urgency = callLog.urgency ?? 'low';
  const urgencyEmoji = urgency === 'high' ? '🔴' : urgency === 'medium' ? '🟡' : '🟢';
  const actions: string[] = [];
  try {
    if (callLog.promisedActions) actions.push(...JSON.parse(callLog.promisedActions));
  } catch {
    // ignore
  }
  const message = dedupeReasonAndSummary(callLog.reasonForCall, callLog.summary);

  const lines = [
    `📞 Missed Call`,
    ``,
    `From: ${callLog.fromNumber}${callLog.callerName ? ` (${callLog.callerName})` : ''}`,
    callLog.company ? `Company: ${callLog.company}` : null,
    ``,
    `${urgencyEmoji} ${(urgency || 'low').toUpperCase()}`,
    ``,
    message ? `Message: ${message}` : null,
    ``,
    callLog.callbackWindow ? `Callback: ${callLog.callbackWindow}` : null,
    actions.length > 0 ? `Actions: ${actions.join('; ')}` : null,
  ];

  const transcriptBlock =
    callLog.transcripts?.length ? formatTranscriptLines(callLog.transcripts) : '';
  if (transcriptBlock) {
    lines.push(``, `Transcript:`, transcriptBlock);
  }

  return lines.filter(Boolean).join('\n');
}

// ── Send Notifications ───────────────────────────────

export async function sendPostCallNotifications(
  summary: CallSummary,
  callLogId: string,
  callerNumber: string,
  transcriptParts?: TranscriptLine[]
): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const message = formatSummaryMessage(summary, callLogId, callerNumber, transcriptParts);

  // Always send SMS
  await sendSMS(message, callLogId, env.OWNER_PHONE_NUMBER);

  // Try WhatsApp if configured
  if (env.OWNER_WHATSAPP_NUMBER) {
    try {
      await sendWhatsApp(message, callLogId, env.OWNER_WHATSAPP_NUMBER);
    } catch (err) {
      log.warn({ callLogId, err }, 'WhatsApp failed, SMS already sent as fallback');
    }
  }
}

/**
 * Sends only the recording (MMS or link) — use when summary was already sent at call end.
 * Includes caller name/number so the owner knows which call this recording belongs to.
 * Uses a proxy link so the recipient can open the recording without Twilio Basic Auth.
 */
// Twilio mp3 recordings run ~68 kbps (~8.5 KB/s). MMS media delivers reliably only up to
// ~600 KB, so past ~70s the attachment silently fails (transcript still arrives via the
// separate summary SMS — hence the old "transcript but no recording" bug). Below this,
// embed the mp3 inline; above it, send a tappable link instead (no size limit, always delivers).
const RECORDING_MMS_MAX_SECONDS = 60;

export async function sendRecordingOnlyNotification(
  callLogId: string,
  _recordingUrl: string,
  callerInfo?: { fromNumber: string; callerName: string | null },
  durationSeconds?: number | null
): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const to = env.OWNER_PHONE_NUMBER;
  const recordingProxyUrl = `${env.BASE_URL}/voice/recording/${callLogId}${env.DASHBOARD_TOKEN ? `?token=${encodeURIComponent(env.DASHBOARD_TOKEN)}` : ''}`;
  const statusCallback = `${env.BASE_URL}/sms/status`;

  const callerDisplay = callerInfo
    ? callerInfo.callerName
      ? `${callerInfo.callerName} (${callerInfo.fromNumber})`
      : callerInfo.fromNumber
    : 'Recent call';

  const useLink = durationSeconds == null || durationSeconds > RECORDING_MMS_MAX_SECONDS;
  const body = useLink
    ? `📞 Call recording — ${callerDisplay}\nListen: ${recordingProxyUrl}`
    : `📞 Call recording — ${callerDisplay}`;

  try {
    const msg = await getTwilioClient().messages.create({
      body,
      from: env.TWILIO_PHONE_NUMBER,
      to,
      ...(useLink ? {} : { mediaUrl: [recordingProxyUrl] }),
      statusCallback,
    });
    await createNotification({
      callLogId,
      channel: 'sms',
      recipient: to,
      status: 'sent',
      messageId: msg.sid,
      sentAt: new Date(),
    });
    log.info({ callLogId, messageSid: msg.sid, delivery: useLink ? 'link' : 'mms' }, 'Recording sent');
  } catch (err: unknown) {
    log.error({ callLogId, err }, 'Failed to send recording SMS');
  }
  if (env.OWNER_WHATSAPP_NUMBER) {
    try {
      // WhatsApp has no MMS-style size ceiling here, so always send the link (avoids
      // duplicating it when `body` already contains "Listen: {url}").
      await sendWhatsApp(`📞 Call recording — ${callerDisplay}\nListen: ${recordingProxyUrl}`, callLogId, env.OWNER_WHATSAPP_NUMBER);
    } catch (err) {
      log.warn({ callLogId, err }, 'WhatsApp recording notification failed');
    }
  }
}

/**
 * Sends one SMS (and optionally WhatsApp) with summary + recording link (or MMS with audio).
 * Use when recording is ready and summary was NOT already sent (e.g. 90s fallback path).
 * Recording link is a proxy URL so the recipient can open it without Twilio Basic Auth.
 */
export async function sendCombinedCallNotification(
  callLog: CallLogForNotification,
  _recordingUrl: string
): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const summaryText = formatSummaryFromCallLog(callLog);
  const recordingProxyUrl = `${env.BASE_URL}/voice/recording/${callLog.id}${env.DASHBOARD_TOKEN ? `?token=${encodeURIComponent(env.DASHBOARD_TOKEN)}` : ''}`;
  const statusCallback = `${env.BASE_URL}/sms/status`;
  // Recording goes as a tappable link, not MMS media — Twilio drops oversized attachments
  // (a ~90s call already exceeds the MMS limit), which silently loses the recording.
  const body = `${summaryText}\n\n📞 Recording: ${recordingProxyUrl}`;
  try {
    const msg = await getTwilioClient().messages.create({
      body,
      from: env.TWILIO_PHONE_NUMBER,
      to: env.OWNER_PHONE_NUMBER,
      statusCallback,
    });
    await createNotification({
      callLogId: callLog.id,
      channel: 'sms',
      recipient: env.OWNER_PHONE_NUMBER,
      status: 'sent',
      messageId: msg.sid,
      sentAt: new Date(),
    });
    log.info({ callLogId: callLog.id, messageSid: msg.sid }, 'Combined summary + recording sent via MMS');
  } catch (err: unknown) {
    log.error({ callLogId: callLog.id, err }, 'Failed to send combined summary MMS');
  }
  if (env.OWNER_WHATSAPP_NUMBER) {
    try {
      await sendWhatsApp(summaryText, callLog.id, env.OWNER_WHATSAPP_NUMBER);
    } catch (err) {
      log.warn({ callLogId: callLog.id, err }, 'WhatsApp combined notification failed');
    }
  }
}

/**
 * Sends summary only (no recording). Used when recording never arrives (fallback).
 */
export async function sendSummaryOnlyFromCallLog(callLog: CallLogForNotification): Promise<void> {
  const env = getEnv();
  const message = formatSummaryFromCallLog(callLog);
  await sendSMS(message, callLog.id, env.OWNER_PHONE_NUMBER);
  if (env.OWNER_WHATSAPP_NUMBER) {
    try {
      await sendWhatsApp(message, callLog.id, env.OWNER_WHATSAPP_NUMBER);
    } catch {
      // ignore
    }
  }
}

/**
 * Sends post-SMS-conversation notification to the owner.
 * Same as sendPostCallNotifications but with a 💬 header instead of 📞.
 */
export async function sendPostSmsNotifications(
  summary: CallSummary,
  callLogId: string,
  senderNumber: string,
  transcriptParts?: TranscriptLine[]
): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const urgencyEmoji =
    summary.urgency === 'high' ? '🔴' : summary.urgency === 'medium' ? '🟡' : '🟢';
  const message = dedupeReasonAndSummary(summary.reason_for_call, summary.summary);
  const sentimentLabel = summary.sentiment && summary.sentiment !== 'neutral'
    ? ` | Tone: ${summary.sentiment}`
    : '';

  const lines = [
    `💬 Text Message`,
    ``,
    `From: ${senderNumber}${summary.caller_name ? ` (${summary.caller_name})` : ''}`,
    ``,
    `${urgencyEmoji} ${summary.urgency.toUpperCase()}${sentimentLabel}`,
    ``,
    message ? `Message: ${message}` : null,
    ``,
    summary.callback_window ? `Callback: ${summary.callback_window}` : null,
    summary.promised_actions.length > 0
      ? `Actions: ${summary.promised_actions.join('; ')}`
      : null,
  ];

  const transcriptBlock = transcriptParts?.length
    ? formatTranscriptLines(transcriptParts)
    : '';
  if (transcriptBlock) {
    lines.push(``, `Transcript:`, transcriptBlock);
  }

  const msg = lines.filter(Boolean).join('\n');

  await sendSMS(msg, callLogId, env.OWNER_PHONE_NUMBER);
  if (env.OWNER_WHATSAPP_NUMBER) {
    try {
      await sendWhatsApp(msg, callLogId, env.OWNER_WHATSAPP_NUMBER);
    } catch (err) {
      log.warn({ callLogId, err }, 'WhatsApp failed for SMS notification');
    }
  }
}

/**
 * Sends an urgent escalation SMS when the caller requests a warm transfer.
 */
export async function sendEscalationSMS(callLogId: string, fromNumber: string, reason: string): Promise<void> {
  const env = getEnv();
  const body = `🚨 URGENT — Caller wants to speak to you NOW.\nFrom: ${fromNumber}\nReason: ${reason}`;
  await sendSMS(body, callLogId, env.OWNER_PHONE_NUMBER);
}

/**
 * Send an SMS to an arbitrary recipient (e.g. for voice command "text John ...").
 * Uses the same Twilio path and logs to the given call log for audit.
 */
export async function sendSMSToRecipient(body: string, toPhone: string, callLogId: string): Promise<void> {
  await sendSMS(body, callLogId, toPhone);
}

const SMS_MAX_CHARS = 1580;
// ponytail: hard cap of 4 chunks (~6300 chars) — beyond that the tail is cut; dashboard has the full transcript
const MAX_CHUNKS = 4;

/**
 * Split a long body into (n/m)-prefixed chunks on line boundaries so the
 * transcript arrives in follow-up messages instead of being silently cut off
 * (the old truncation dropped the Transcript block entirely on long calls).
 */
function chunkBody(body: string): string[] {
  if (body.length <= SMS_MAX_CHARS) return [body];
  const raw: string[] = [];
  let rest = body;
  while (rest.length > 0 && raw.length < MAX_CHUNKS) {
    if (rest.length <= SMS_MAX_CHARS) {
      raw.push(rest);
      rest = '';
      break;
    }
    let cut = rest.lastIndexOf('\n', SMS_MAX_CHARS);
    if (cut < SMS_MAX_CHARS / 2) cut = SMS_MAX_CHARS;
    raw.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) raw[raw.length - 1] += '\n…[truncated — full transcript on dashboard]';
  return raw.map((c, i) => `(${i + 1}/${raw.length}) ${c}`);
}

async function sendSMS(body: string, callLogId: string, to: string): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const statusCallback = `${env.BASE_URL}/sms/status`;

  for (const chunk of chunkBody(body)) {
  try {
    const msg = await getTwilioClient().messages.create({
      body: chunk,
      from: env.TWILIO_PHONE_NUMBER,
      to,
      statusCallback,
    });

    await createNotification({
      callLogId,
      channel: 'sms',
      recipient: to,
      status: 'sent',
      messageId: msg.sid,
      sentAt: new Date(),
    });

    log.info({ callLogId, messageSid: msg.sid }, 'SMS notification sent');
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 21608) {
      log.warn(
        { callLogId, to },
        'SMS failed: trial accounts only send to Verified Caller IDs. Add this number in Twilio Console → Phone Numbers → Verified Caller IDs.'
      );
    } else {
      log.error({ callLogId, err }, 'SMS notification failed');
    }

    await createNotification({
      callLogId,
      channel: 'sms',
      recipient: to,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    break; // first failed chunk → later chunks will fail too; stop spamming
  }
  }
}

async function sendWhatsApp(body: string, callLogId: string, to: string): Promise<void> {
  const log = getLogger();
  const env = getEnv();

  // Use sandbox number if set (e.g. +14155238886); otherwise your Twilio number (must be WhatsApp-enabled)
  const fromNumber = env.TWILIO_WHATSAPP_FROM || env.TWILIO_PHONE_NUMBER;
  const whatsappTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const whatsappFrom = `whatsapp:${fromNumber}`;
  const statusCallback = `${env.BASE_URL}/sms/status`;

  for (const chunk of chunkBody(body)) {
  try {
    const msg = await getTwilioClient().messages.create({
      body: chunk,
      from: whatsappFrom,
      to: whatsappTo,
      statusCallback,
    });

    await createNotification({
      callLogId,
      channel: 'whatsapp',
      recipient: to,
      status: 'sent',
      messageId: msg.sid,
      sentAt: new Date(),
    });

    log.info({ callLogId, messageSid: msg.sid }, 'WhatsApp notification sent');
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    // 63007 = Twilio WhatsApp channel not set up for this number; SMS already sent
    if (code === 63007) {
      log.info({ callLogId }, 'WhatsApp not configured for this number; SMS sent');
    } else {
      log.error({ callLogId, err }, 'WhatsApp notification failed');
    }

    await createNotification({
      callLogId,
      channel: 'whatsapp',
      recipient: to,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });

    if (code !== 63007) throw err;
    return; // WhatsApp not configured — don't retry remaining chunks
  }
  }
}
