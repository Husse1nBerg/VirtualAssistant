/**
 * SMS Brain — Inbound SMS handling
 *
 * When someone texts the Twilio number, this service manages a stateful
 * multi-turn conversation to collect their name and message for Hussein.
 *
 * Design:
 * - State tracked in-memory per fromNumber (sessions expire after 30 min)
 * - Uses Anthropic Claude to decide what to reply and when the conversation
 *   is complete enough to generate a structured summary
 * - On completion: creates a CallLog (direction="sms"), saves transcript,
 *   and fires post-call notifications to the owner
 */

import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import {
  createCallLog,
  addTranscript,
  updateCallLog,
  getContactByPhone,
  getRecentCallsByNumber,
} from './database';
import { sendPostSmsNotifications } from './notification';
import type { CallSummary } from './claude';
import { v4 as uuidv4 } from 'uuid';
import { buildCallerContextBlock } from './agentPrompt';

// ── Types ────────────────────────────────────────────

interface SmsSession {
  callLogId: string;
  fromNumber: string;
  turns: { role: 'user' | 'assistant'; content: string }[];
  lastActivityAt: number;
  complete: boolean;
}

// ── Session Store ─────────────────────────────────────

const sessions = new Map<string, SmsSession>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function pruneExpiredSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, session] of sessions.entries()) {
    if (session.lastActivityAt < cutoff) {
      sessions.delete(key);
    }
  }
}

// ── System Prompt for SMS ─────────────────────────────

const SMS_SYSTEM_PROMPT = `You are Hussein Bayoun's SMS assistant. Your job is to collect a message from the texter to pass along to Hussein.

RULES:
- Keep replies SHORT — 1-2 sentences maximum. This is SMS, not a chat app.
- Be warm and natural. Do not sound like a bot.
- Collect: caller's name, and their message/reason for texting.
- Once you have BOTH the name AND a clear message, respond with a brief confirmation and nothing else.
- Do NOT ask multiple questions at once. One question per reply.
- Do NOT promise specific callback times.
- If the texter is abrupt or rude, stay calm and professional.
- Language: match the texter's language (French, Arabic, English, etc.).

FLOW:
1. Greet and ask who is texting (if not already stated).
2. Ask what the message is for Hussein (if not already given).
3. Confirm: "Got it — I'll pass that along to Hussein right away."
4. That's it. No more messages from you after the confirmation.

When you have enough info to confirm, your final reply MUST end with exactly this JSON on a new line:
###SUMMARY###{"caller_name":"<name>","reason":"<short reason>","urgency":"<low|medium|high>","sentiment":"<positive|neutral|frustrated|angry>","full_summary":"<2-3 sentences for Hussein>"}`;

// ── Anthropic Client ──────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const env = getEnv();
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required for SMS brain — set it in your .env');
    }
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Extract embedded summary JSON ────────────────────

interface SmsSummaryJson {
  caller_name: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  sentiment?: 'positive' | 'neutral' | 'frustrated' | 'angry';
  full_summary: string;
}

function extractSummaryFromReply(reply: string): { text: string; summary: SmsSummaryJson | null } {
  const marker = '###SUMMARY###';
  const idx = reply.indexOf(marker);
  if (idx === -1) return { text: reply.trim(), summary: null };

  const text = reply.slice(0, idx).trim();
  try {
    const jsonStr = reply.slice(idx + marker.length).trim();
    const summary = JSON.parse(jsonStr) as SmsSummaryJson;
    return { text, summary };
  } catch {
    return { text: reply.trim(), summary: null };
  }
}

// ── Handle incoming SMS message ───────────────────────

export async function handleIncomingSms(
  fromNumber: string,
  body: string,
  toNumber: string
): Promise<string> {
  const log = getLogger();
  const env = getEnv();
  pruneExpiredSessions();

  // Check if this texter already has a session
  let session = sessions.get(fromNumber);

  if (!session) {
    // New session — create a call log immediately
    const twilioCallSid = `sms-${uuidv4()}`;
    let callLogId: string;
    try {
      const callLog = await createCallLog({
        twilioCallSid,
        fromNumber,
        toNumber,
      });
      // Mark as SMS direction
      await updateCallLog(callLog.id, { direction: 'sms', status: 'in-progress' });
      callLogId = callLog.id;
    } catch (err) {
      log.error({ err, fromNumber }, 'Failed to create SMS call log');
      return "Hi, this is Hussein's assistant. What can I pass along to him?";
    }

    // Fetch caller context
    let callerContextBlock = '';
    try {
      const [contact, recentCalls] = await Promise.all([
        getContactByPhone(fromNumber),
        getRecentCallsByNumber(fromNumber, 3),
      ]);
      callerContextBlock = buildCallerContextBlock(contact, recentCalls);
    } catch {
      // non-fatal
    }

    session = {
      callLogId,
      fromNumber,
      turns: [],
      lastActivityAt: Date.now(),
      complete: false,
    };
    sessions.set(fromNumber, session);

    // If we have caller context, embed it in the system prompt as a hidden note
    if (callerContextBlock) {
      session.turns.push({
        role: 'assistant',
        content: `[Context for assistant only — do not quote this]\n${callerContextBlock}`,
      });
    }

    log.info({ fromNumber, callLogId }, 'New SMS session started');
  }

  if (session.complete) {
    // Session already completed — start a fresh one by deleting the old one
    sessions.delete(fromNumber);
    return handleIncomingSms(fromNumber, body, toNumber);
  }

  session.lastActivityAt = Date.now();
  session.turns.push({ role: 'user', content: body });

  // Save user turn to DB
  addTranscript(session.callLogId, 'caller', body).catch((err) =>
    log.error({ err }, 'Failed to save SMS transcript turn')
  );

  // Call LLM
  let replyText: string;
  let summary: SmsSummaryJson | null = null;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: SMS_SYSTEM_PROMPT + (env.OOO_ENABLED
        ? `\n\nOUT OF OFFICE: Hussein is away${env.OOO_UNTIL ? ` until ${env.OOO_UNTIL}` : ''}. Mention this naturally if asked.`
        : ''),
      messages: session.turns.filter((t) => !(t.content.startsWith('[Context'))).map((t) => ({
        role: t.role,
        content: t.content,
      })),
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    const extracted = extractSummaryFromReply(raw);
    replyText = extracted.text || "Got it — I'll pass that along to Hussein right away.";
    summary = extracted.summary;
  } catch (err) {
    log.error({ err, fromNumber }, 'Claude SMS reply failed');
    replyText = "Got it — I'll pass your message along to Hussein.";
  }

  session.turns.push({ role: 'assistant', content: replyText });

  // Save assistant turn to DB
  addTranscript(session.callLogId, 'assistant', replyText).catch((err) =>
    log.error({ err }, 'Failed to save SMS assistant transcript turn')
  );

  // If summary extracted → complete the session
  if (summary) {
    session.complete = true;
    sessions.delete(fromNumber);

    const callSummary: CallSummary = {
      caller_name: summary.caller_name || null,
      company: null,
      reason_for_call: summary.reason || 'SMS message',
      urgency: summary.urgency || 'medium',
      callback_window: null,
      promised_actions: ['Reply to SMS'],
      sentiment: summary.sentiment,
      confidence_score: 0.85,
      summary: summary.full_summary || `${summary.caller_name || 'Unknown'} sent a text: ${body}`,
    };

    // Finalize call log
    updateCallLog(session.callLogId, {
      status: 'completed',
      endedAt: new Date(),
      durationSeconds: Math.round((Date.now() - (session.lastActivityAt)) / 1000),
      callerName: callSummary.caller_name,
      reasonForCall: callSummary.reason_for_call,
      urgency: callSummary.urgency,
      sentiment: callSummary.sentiment ?? null,
      confidenceScore: callSummary.confidence_score,
      summary: callSummary.summary,
    }).catch((err) => log.error({ err }, 'Failed to finalize SMS call log'));

    // Notify owner
    const transcriptParts = session.turns
      .filter((t) => !t.content.startsWith('[Context'))
      .map((t) => ({ role: t.role === 'user' ? 'caller' : 'assistant', content: t.content }));

    sendPostSmsNotifications(callSummary, session.callLogId, fromNumber, transcriptParts).catch(
      (err) => log.error({ err }, 'Failed to send SMS notification to owner')
    );

    log.info({ fromNumber, callLogId: session.callLogId }, 'SMS session completed — owner notified');
  }

  return replyText;
}

export function getActiveSmsSessionCount(): number {
  pruneExpiredSessions();
  return sessions.size;
}
