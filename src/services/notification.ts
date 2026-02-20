import twilio from 'twilio';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { createNotification } from './database';
import type { CallSummary } from './claude';

let _twilioClient: twilio.Twilio | null = null;

function getTwilioClient(): twilio.Twilio {
  if (!_twilioClient) {
    const env = getEnv();
    _twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
}

// ── Format Summary Message ───────────────────────────

function formatSummaryMessage(summary: CallSummary, callLogId: string, callerNumber: string): string {
  const urgencyEmoji =
    summary.urgency === 'high' ? '🔴' : summary.urgency === 'medium' ? '🟡' : '🟢';

  const lines = [
    `📞 Missed Call Summary`,
    `━━━━━━━━━━━━━━━━━━`,
    `From: ${callerNumber}${summary.caller_name ? ` (${summary.caller_name})` : ''}`,
    summary.company ? `Company: ${summary.company}` : null,
    ``,
    `${urgencyEmoji} Urgency: ${summary.urgency.toUpperCase()}`,
    `Reason: ${summary.reason_for_call}`,
    summary.callback_window ? `Callback: ${summary.callback_window}` : null,
    summary.promised_actions.length > 0
      ? `Actions: ${summary.promised_actions.join('; ')}`
      : null,
    ``,
    `Summary: ${summary.summary}`,
    `Confidence: ${Math.round(summary.confidence_score * 100)}%`,
    `Ref: ${callLogId}`,
  ];

  return lines.filter(Boolean).join('\n');
}

// ── Send Notifications ───────────────────────────────

export async function sendPostCallNotifications(
  summary: CallSummary,
  callLogId: string,
  callerNumber: string
): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const message = formatSummaryMessage(summary, callLogId, callerNumber);

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

async function sendSMS(body: string, callLogId: string, to: string): Promise<void> {
  const log = getLogger();
  const env = getEnv();

  try {
    const msg = await getTwilioClient().messages.create({
      body,
      from: env.TWILIO_PHONE_NUMBER,
      to,
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
  }
}

async function sendWhatsApp(body: string, callLogId: string, to: string): Promise<void> {
  const log = getLogger();
  const env = getEnv();

  // Use sandbox number if set (e.g. +14155238886); otherwise your Twilio number (must be WhatsApp-enabled)
  const fromNumber = env.TWILIO_WHATSAPP_FROM || env.TWILIO_PHONE_NUMBER;
  const whatsappTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const whatsappFrom = `whatsapp:${fromNumber}`;

  try {
    const msg = await getTwilioClient().messages.create({
      body,
      from: whatsappFrom,
      to: whatsappTo,
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
  }
}
