import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../utils/logger';
import { getEnv } from '../config';
import { buildAgentSettings, buildAgentSettingsWithClaude } from './agentPrompt';
import {
  createCallLog,
  getCallLogBySid,
  updateCallLog,
  addTranscript,
  getContactByPhone,
  getRecentCallsByNumber,
} from './database';
import { sendPostCallNotifications, sendEscalationSMS } from './notification';
import { getTwilioClient } from './twilioClient';
import type { CallSummary } from './claude';

// ── Types ────────────────────────────────────────────

interface CallSession {
  callId: string;
  callSid: string;
  streamSid: string;
  fromNumber: string;
  toNumber: string;
  twilioWs: WebSocket;       // Twilio Media Stream
  agentWs: WebSocket | null; // Deepgram Agent
  startTime: number;
  ended: boolean;
  transcriptParts: { role: string; content: string }[];
  summary: CallSummary | null;
}

// ── Active Sessions ──────────────────────────────────

const sessions = new Map<string, CallSession>();

const MAX_CALL_DURATION_MS = 10 * 60 * 1000; // 10 minutes

// ── Main Handler ─────────────────────────────────────

export async function handleMediaStreamConnection(twilioWs: WebSocket): Promise<void> {
  const log = getLogger();
  let session: CallSession | null = null;

  twilioWs.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'connected':
          log.info('Twilio Media Stream connected');
          break;

        case 'start':
          session = await initializeSession(twilioWs, msg.start);
          break;

        case 'media':
          if (session?.agentWs?.readyState === WebSocket.OPEN) {
            // Forward raw mulaw audio from Twilio → Deepgram Agent
            const audio = Buffer.from(msg.media.payload, 'base64');
            session.agentWs.send(audio);
          }
          break;

        case 'stop':
          if (session) await endCall(session, 'completed');
          break;

        default:
          log.debug({ event: msg.event }, 'Unhandled Twilio event');
      }
    } catch (err) {
      log.error({ err }, 'Error processing Twilio message');
      if (session) await endCall(session, 'failed');
    }
  });

  twilioWs.on('close', async () => {
    log.info({ callId: session?.callId }, 'Twilio WebSocket closed');
    if (session) await endCall(session, 'completed');
  });

  twilioWs.on('error', async (err) => {
    log.error({ err, callId: session?.callId }, 'Twilio WebSocket error');
    if (session) await endCall(session, 'failed');
  });
}

// ── Session Initialization ───────────────────────────

async function initializeSession(
  twilioWs: WebSocket,
  startData: { streamSid: string; callSid: string; customParameters?: Record<string, string> }
): Promise<CallSession> {
  const log = getLogger();
  const env = getEnv();

  const fromNumber = startData.customParameters?.from || 'unknown';
  const toNumber = startData.customParameters?.to || 'unknown';

  // Reuse the call log created in /inbound; fall back to creating one if missing.
  const callLog =
    (await getCallLogBySid(startData.callSid)) ??
    (await createCallLog({ twilioCallSid: startData.callSid, fromNumber, toNumber }));

  // Fetch caller context (contact + recent calls) in parallel — errors are non-fatal
  let contact: Awaited<ReturnType<typeof getContactByPhone>> = null;
  let recentCalls: Awaited<ReturnType<typeof getRecentCallsByNumber>> = [];
  try {
    [contact, recentCalls] = await Promise.all([
      getContactByPhone(fromNumber),
      getRecentCallsByNumber(fromNumber, 3),
    ]);
  } catch {
    // non-fatal; continue with empty context
  }

  const callerCtx = { contact, recentCalls };

  const session: CallSession = {
    callId: callLog.id,
    callSid: startData.callSid,
    streamSid: startData.streamSid,
    fromNumber,
    toNumber,
    twilioWs,
    agentWs: null,
    startTime: Date.now(),
    ended: false,
    transcriptParts: [],
    summary: null,
  };

  sessions.set(startData.streamSid, session);

  log.info(
    { callId: session.callId, callSid: session.callSid, from: fromNumber },
    'Call session created — connecting to Deepgram Agent'
  );

  // ── Connect to Deepgram Voice Agent ──────────────
  const deepgramKey = env.DEEPGRAM_API_KEY.trim();
  const agentWs = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', {
    headers: {
      Authorization: `Token ${deepgramKey}`,
    },
  });

  session.agentWs = agentWs;

  agentWs.on('open', () => {
    log.info({ callId: session.callId }, 'Deepgram Agent WebSocket connected');

    // Send agent configuration: OpenAI (managed by Deepgram) or Anthropic
    const settings = env.USE_OPENAI_FOR_AGENT
      ? buildAgentSettings(env.DEEPGRAM_API_KEY, callerCtx)
      : buildAgentSettingsWithClaude(env.DEEPGRAM_API_KEY, env.ANTHROPIC_API_KEY || '', callerCtx);

    agentWs.send(JSON.stringify(settings));
    log.info({ callId: session.callId }, 'Agent settings sent');
  });

  agentWs.on('message', (data: Buffer) => {
    const msgStr = data.toString();

    // Deepgram Agent sends two types of messages:
    // 1. Binary audio (TTS output) → forward to Twilio
    // 2. JSON events (transcripts, function calls, etc.)

    // Check if it's binary audio
    if (!msgStr.startsWith('{') && !msgStr.startsWith('[')) {
      // Binary audio from agent TTS → send to Twilio as base64
      forwardAudioToTwilio(session, data);
      return;
    }

    // JSON event
    try {
      const event = JSON.parse(msgStr);
      handleAgentEvent(session, event);
    } catch {
      // If it's not valid JSON, treat as binary audio
      forwardAudioToTwilio(session, data);
    }
  });

  agentWs.on('close', (code, reason) => {
    log.info({ callId: session.callId, code, reason: reason.toString() }, 'Deepgram Agent disconnected');
    if (!session.ended) {
      endCall(session, 'completed');
    }
  });

  agentWs.on('error', (err) => {
    log.error({ callId: session.callId, err }, 'Deepgram Agent WebSocket error');
    if (!session.ended) {
      endCall(session, 'failed');
    }
  });

  // Max call duration safety net
  setTimeout(() => {
    if (sessions.has(startData.streamSid) && !session.ended) {
      log.warn({ callId: session.callId }, 'Max call duration reached — ending');
      endCall(session, 'completed');
    }
  }, MAX_CALL_DURATION_MS);

  return session;
}

// ── Handle Deepgram Agent Events ─────────────────────

function handleAgentEvent(session: CallSession, event: any): void {
  const log = getLogger();

  switch (event.type) {
    // User (caller) speech transcribed
    case 'UserStartedSpeaking':
      log.debug({ callId: session.callId }, 'Caller started speaking');
      break;

    case 'ConversationText': {
      // Both user and agent transcript turns
      const role = event.role; // "user" or "assistant"
      const content = event.content || '';

      if (content) {
        log.info({ callId: session.callId, role, content }, 'Conversation turn');
        session.transcriptParts.push({
          role: role === 'user' ? 'caller' : 'assistant',
          content,
        });

        // Persist to DB async
        addTranscript(
          session.callId,
          role === 'user' ? 'caller' : 'assistant',
          content
        ).catch((err) => log.error({ err }, 'Failed to save transcript'));
      }
      break;
    }

    case 'FunctionCallRequest': {
      // Agent wants to call one of our defined functions
      log.info(
        { callId: session.callId, functionName: event.function_name, params: event.input },
        'Agent function call'
      );

      if (event.function_name === 'end_call_summary') {
        handleEndCallSummary(session, event.input, event.function_call_id);
      } else if (event.function_name === 'request_transfer') {
        handleTransferRequest(session, event.input, event.function_call_id).catch((err) =>
          log.error({ callId: session.callId, err }, 'Transfer request failed')
        );
      }
      break;
    }

    case 'AgentThinking':
      log.debug({ callId: session.callId }, 'Agent thinking...');
      break;

    case 'AgentStartedSpeaking':
      log.debug({ callId: session.callId }, 'Agent started speaking');
      break;

    case 'AgentAudioDone':
      log.debug({ callId: session.callId }, 'Agent finished audio chunk');
      break;

    case 'Error':
      log.error({ callId: session.callId, error: event }, 'Deepgram Agent error event');
      break;

    default:
      log.debug({ callId: session.callId, type: event.type }, 'Unhandled agent event');
  }
}

// ── Forward Audio: Deepgram Agent → Twilio ──────────

function forwardAudioToTwilio(session: CallSession, audioData: Buffer): void {
  if (session.twilioWs.readyState !== WebSocket.OPEN) return;

  const payload = {
    event: 'media',
    streamSid: session.streamSid,
    media: {
      payload: audioData.toString('base64'),
    },
  };

  session.twilioWs.send(JSON.stringify(payload));
}

// ── Handle the end_call_summary function call ────────

async function handleEndCallSummary(
  session: CallSession,
  input: any,
  functionCallId: string
): Promise<void> {
  const log = getLogger();

  const summary: CallSummary = {
    caller_name: input.caller_name || null,
    company: input.company || null,
    reason_for_call: input.reason_for_call || 'Unknown',
    urgency: input.urgency || 'medium',
    callback_window: input.callback_window || null,
    promised_actions: input.promised_actions || [],
    sentiment: input.sentiment || undefined,
    confidence_score: input.confidence_score ?? 0.5,
    summary: input.full_summary || 'No summary available.',
  };

  session.summary = summary;

  log.info({ callId: session.callId, summary }, 'Call summary extracted via function call');

  // Send function response back to agent so it can continue (say goodbye)
  if (session.agentWs?.readyState === WebSocket.OPEN) {
    session.agentWs.send(
      JSON.stringify({
        type: 'FunctionCallResponse',
        function_call_id: functionCallId,
        output: 'Summary captured. You may now say goodbye to the caller.',
      })
    );
  }
}

// ── Warm Transfer ────────────────────────────────────

async function handleTransferRequest(
  session: CallSession,
  input: any,
  functionCallId: string
): Promise<void> {
  const log = getLogger();
  const env = getEnv();
  const reason = (input?.reason as string) || 'No reason given';

  log.info({ callId: session.callId, reason }, 'Transfer requested');

  // Instruct agent to say "please hold" before redirect
  if (session.agentWs?.readyState === WebSocket.OPEN) {
    session.agentWs.send(
      JSON.stringify({
        type: 'FunctionCallResponse',
        function_call_id: functionCallId,
        output: "Transfer initiated. Tell the caller: 'Let me try to connect you right now — please hold.'",
      })
    );
  }

  // Fire escalation SMS (fire-and-forget)
  sendEscalationSMS(session.callId, session.fromNumber, reason).catch((err) =>
    log.error({ callId: session.callId, err }, 'Failed to send escalation SMS')
  );

  // Wait for agent to speak, then redirect the call
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));

  try {
    await getTwilioClient().calls(session.callSid).update({
      url: `${env.BASE_URL}/voice/transfer/${session.callId}`,
      method: 'POST',
    });
    log.info({ callId: session.callId }, 'Call redirected to transfer TwiML');
  } catch (err) {
    log.error({ callId: session.callId, err }, 'Failed to redirect call for transfer');
  }
}

// ── Call Ending ──────────────────────────────────────

async function endCall(session: CallSession, status: string): Promise<void> {
  const log = getLogger();

  // Prevent double-ending
  if (session.ended) return;
  session.ended = true;

  log.info({ callId: session.callId, status }, 'Ending call session');

  sessions.delete(session.streamSid);

  // Close Deepgram Agent connection
  if (session.agentWs?.readyState === WebSocket.OPEN) {
    session.agentWs.close(1000, 'Call ended');
  }

  const durationSeconds = Math.round((Date.now() - session.startTime) / 1000);

  try {
    // Use function-extracted summary, or build a fallback from transcript
    const summary = session.summary || buildFallbackSummary(session);

    // Update call log with all structured data
    await updateCallLog(session.callId, {
      status,
      endedAt: new Date(),
      durationSeconds,
      callerName: summary.caller_name,
      company: summary.company,
      reasonForCall: summary.reason_for_call,
      urgency: summary.urgency,
      callbackWindow: summary.callback_window,
      promisedActions: JSON.stringify(summary.promised_actions),
      sentiment: summary.sentiment ?? null,
      confidenceScore: summary.confidence_score,
      summary: summary.summary,
    });

    // Send summary + line-by-line transcript (Caller/Agent) immediately.
    await sendPostCallNotifications(
      summary,
      session.callId,
      session.fromNumber,
      session.transcriptParts
    );
    // Recording (link or MMS) is sent separately when Twilio calls /voice/recording-status.
    log.info(
      { callId: session.callId, durationSeconds, urgency: summary.urgency },
      'Call completed; summary sent; recording will be sent when ready'
    );
  } catch (err) {
    log.error({ callId: session.callId, err }, 'Error during call wrap-up');

    await updateCallLog(session.callId, {
      status: 'failed',
      endedAt: new Date(),
      durationSeconds,
      usedFallback: true,
    }).catch(() => {});
  }
}

// ── Fallback Summary ─────────────────────────────────
// If the agent didn't call end_call_summary (e.g. caller hung up abruptly),
// build a basic summary from the transcript parts we captured.

function buildFallbackSummary(session: CallSession): CallSummary {
  const callerParts = session.transcriptParts
    .filter((t) => t.role === 'caller')
    .map((t) => t.content);

  const fullTranscript = callerParts.join(' ').replace(/\s+/g, ' ').trim();
  const firstSentence = fullTranscript.split(/[.!?]+/)[0]?.trim() || '';
  const shortReason = firstSentence.length > 0 && firstSentence.length <= 120
    ? firstSentence
    : fullTranscript.slice(0, 80).trim() + (fullTranscript.length > 80 ? '…' : '');

  return {
    caller_name: null,
    company: null,
    reason_for_call: shortReason || 'Caller did not state reason — review transcript',
    urgency: 'medium',
    callback_window: null,
    promised_actions: ['Review transcript and return call'],
    confidence_score: 0.2,
    summary: fullTranscript
      ? fullTranscript.slice(0, 400) + (fullTranscript.length > 400 ? '…' : '')
      : 'Call ended with no caller speech detected. Possible hang-up or wrong number.',
  };
}

// ── Exports ──────────────────────────────────────────

export function getActiveSessionCount(): number {
  return sessions.size;
}
