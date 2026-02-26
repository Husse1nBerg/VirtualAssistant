import { Router, Request, Response } from 'express';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { twilioWebhookAuth } from '../middleware/twilioAuth';
import { createCallLog, getCallLogBySid, getCallLogById, updateCallLog, getContactByPhone } from '../services/database';
import { sendRecordingOnlyNotification, sendSummaryOnlyFromCallLog, sendEscalationSMS } from '../services/notification';
import { getGreetingText } from '../services/agentPrompt';
import { getTwilioClient } from '../services/twilioClient';

const router = Router();

// Cache greeting audio keyed by greeting text (supports generic + personalized greetings).
const greetingCache = new Map<string, Buffer>();

function buildGreetingText(callerName?: string): string {
  if (callerName) {
    return `Hi ${callerName}! This is Hussein's assistant — how can I help you today?`;
  }
  return getGreetingText();
}

/**
 * GET /voice/greeting
 * Generates the call greeting using Deepgram TTS (same voice as the agent).
 * Twilio's <Play> fetches this URL so the caller hears a consistent voice throughout the call.
 * When OOO mode is on (OOO_ENABLED), the greeting says you're away and still taking messages.
 * Result is cached in memory per greeting text — Deepgram is only called once per server process per text.
 */
router.get('/greeting', async (req: Request, res: Response) => {
  const log = getLogger();
  const env = getEnv();
  const callerName = typeof req.query.caller === 'string' ? req.query.caller : undefined;
  const greetingText = buildGreetingText(callerName);

  const cached = greetingCache.get(greetingText);
  if (cached) {
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(cached);
  }

  try {
    const dgRes = await fetch(
      'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: greetingText }),
      }
    );

    if (!dgRes.ok) {
      log.error({ status: dgRes.status }, 'Deepgram TTS failed for greeting');
      return res.status(502).send('TTS unavailable');
    }

    const buffer = Buffer.from(await dgRes.arrayBuffer());
    greetingCache.set(greetingText, buffer);
    log.info({ ooo: getEnv().OOO_ENABLED, callerName }, 'Greeting audio generated and cached');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    log.error({ err }, 'Failed to generate greeting audio');
    res.status(502).send('TTS unavailable');
  }
});

/**
 * GET /voice/recording/:callLogId
 * Proxies the Twilio recording so the link works without Basic Auth.
 * Twilio's RecordingUrl requires Account SID + Auth Token; we fetch with server credentials and stream.
 */
router.get('/recording/:callLogId', async (req: Request, res: Response) => {
  const log = getLogger();
  const callLogId = req.params.callLogId as string;
  const env = getEnv();

  const callLog = await getCallLogById(callLogId);
  if (!callLog?.recordingUrl) {
    log.warn({ callLogId }, 'Recording proxy: call log not found or no recording');
    return res.status(404).send('Recording not found');
  }

  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  // Twilio's RecordingUrl has no extension — append .mp3 to get audio (bare URL returns XML metadata).
  const mp3Url = callLog.recordingUrl!.replace(/\.(mp3|wav|ogg)$/, '') + '.mp3';
  try {
    const twilioRes = await fetch(mp3Url, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: 'follow',
    });
    if (!twilioRes.ok) {
      log.warn({ callLogId, status: twilioRes.status, mp3Url }, 'Twilio recording fetch failed');
      return res.status(502).send('Could not load recording');
    }
    const buffer = Buffer.from(await twilioRes.arrayBuffer());
    log.info({ callLogId, bytes: buffer.length }, 'Recording proxy: served audio');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    log.error({ callLogId, err }, 'Recording proxy error');
    res.status(502).send('Could not load recording');
  }
});

/**
 * POST /voice/inbound
 * Twilio hits this when a call comes in.
 * Returns TwiML that connects a Media Stream WebSocket.
 * On any error, returns TwiML that redirects to fallback (voicemail) so Twilio never plays "application error".
 */
router.post('/inbound', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  res.type('text/xml');

  try {
    const env = getEnv();
    const callSid = req.body.CallSid;
    const from = req.body.From || 'unknown';
    const to = req.body.To || 'unknown';

    log.info({ requestId: req.requestId, callSid, from, to }, 'Inbound call received');

    // Create call log immediately so short calls (hang-up during greeting) are still recorded.
    await createCallLog({ twilioCallSid: callSid, fromNumber: from, toNumber: to });

    // Look up contact for personalized greeting (non-fatal if it fails)
    let greetingParams = '';
    try {
      const contact = await getContactByPhone(from);
      if (contact) {
        greetingParams = `?caller=${encodeURIComponent(contact.name)}&vip=${contact.isVip}`;
      }
    } catch (err) {
      log.warn({ err }, 'Failed to look up contact for greeting — using generic greeting');
    }

    const twiml = new VoiceResponse();
    const wsUrl = env.BASE_URL.replace(/^http/, 'ws') + '/media-stream';
    const recordingCallbackUrl = `${env.BASE_URL}/voice/recording-status`;

    // Start recording via TwiML (works with Stream; REST API can return 21220 for Stream calls).
    const start = twiml.start();
    start.recording({
      recordingStatusCallback: recordingCallbackUrl,
      recordingStatusCallbackEvent: ['completed'],
    });

    // Play greeting via Deepgram TTS (same voice as the agent) — blocks until complete before <Connect>.
    // Twilio fetches /voice/greeting, which calls Deepgram and returns the MP3.
    twiml.play(`${env.BASE_URL}/voice/greeting${greetingParams}`);

    const connect = twiml.connect();
    const stream = connect.stream({ url: wsUrl });
    stream.parameter({ name: 'from', value: from });
    stream.parameter({ name: 'to', value: to });
    stream.parameter({ name: 'callSid', value: callSid });

    return res.send(twiml.toString());
  } catch (err) {
    log.error({ err, requestId: req.requestId }, 'Inbound handler error — redirecting to fallback');
    const twiml = new VoiceResponse();
    const baseUrl = process.env.BASE_URL;
    if (baseUrl) {
      twiml.redirect({ method: 'POST' }, `${baseUrl}/voice/fallback`);
    } else {
      twiml.say({ voice: 'Polly.Joanna' }, "I'm sorry, we're having technical difficulties. Please try again later.");
      twiml.hangup();
    }
    return res.send(twiml.toString());
  }
});

/**
 * POST /voice/recording-status
 * Twilio callback when call recording is ready. Saves recording URL to call log.
 * If you see "Twilio recording-status webhook received" in logs after a call, Twilio is reaching this URL.
 */
router.post('/recording-status', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const callSid = req.body.CallSid;
  const recordingSid = req.body.RecordingSid;
  const recordingUrl = req.body.RecordingUrl;

  log.info(
    { requestId: req.requestId, callSid, recordingSid, recordingUrl },
    'Twilio recording-status webhook received — recording ready'
  );

  try {
    const callLog = await getCallLogBySid(callSid);
    if (callLog) {
      await updateCallLog(callLog.id, { recordingSid, recordingUrl });
      sendRecordingOnlyNotification(callLog.id, recordingUrl, {
        fromNumber: callLog.fromNumber,
        callerName: callLog.callerName,
      }).catch((err) =>
        log.error({ callSid, err }, 'Failed to send recording notification')
      );
    } else {
      log.warn({ callSid }, 'Recording received but no call log found for this CallSid');
    }
  } catch (err) {
    log.error({ callSid, err }, 'Failed to save recording URL to call log');
  }

  res.sendStatus(200);
});

/**
 * POST /voice/status
 * Twilio status callback — receives call status updates.
 */
router.post('/status', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const duration = req.body.CallDuration;

  log.info({ requestId: req.requestId, callSid, callStatus, duration }, 'Call status update');

  // Update call log if exists
  try {
    const callLog = await getCallLogBySid(callSid);
    if (callLog) {
      await updateCallLog(callLog.id, {
        status: callStatus,
        durationSeconds: duration ? parseInt(duration, 10) : undefined,
        endedAt: callStatus === 'completed' ? new Date() : undefined,
      });
      // If call completed, fallback: send summary-only SMS if recording never arrives (e.g. after 90s)
      if (callStatus === 'completed') {
        setTimeout(async () => {
          try {
            const log = await getCallLogBySid(callSid);
            if (log && !log.recordingUrl) {
              getLogger().info({ callSid }, 'No recording received; sending summary only');
              const withTranscripts = await getCallLogById(log.id);
              if (withTranscripts) {
                await sendSummaryOnlyFromCallLog({
                  ...withTranscripts,
                  transcripts: withTranscripts.transcripts?.map((t) => ({
                    role: t.role,
                    content: t.content,
                  })),
                });
              }
            }
          } catch (e) {
            getLogger().error({ callSid, err: e }, 'Fallback summary send failed');
          }
        }, 90_000);
      }
    }
  } catch (err) {
    log.error({ callSid, err }, 'Failed to update call status');
  }

  res.sendStatus(200);
});

/**
 * POST /voice/fallback
 * Twilio fallback URL — if primary webhook fails, capture voicemail.
 */
router.post('/fallback', twilioWebhookAuth, (req: Request, res: Response) => {
  const log = getLogger();
  const callSid = req.body.CallSid;

  log.warn({ requestId: req.requestId, callSid }, 'Fallback triggered — recording voicemail');

  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'Polly.Joanna' },
    "Hi, I'm sorry but I'm unable to take your call right now. Please leave a message after the beep and Hussein will get back to you as soon as possible."
  );
  twiml.record({
    maxLength: 120,
    action: '/voice/voicemail-complete',
    transcribe: true,
    transcribeCallback: '/voice/voicemail-transcription',
  });
  twiml.say({ voice: 'Polly.Joanna' }, 'I did not receive a recording. Goodbye.');

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/voicemail-complete
 * Called after voicemail recording finishes.
 */
router.post('/voicemail-complete', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const recordingSid = req.body.RecordingSid;

  log.info({ callSid, recordingSid, recordingUrl }, 'Voicemail recorded');

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Thank you. Your message has been recorded. Goodbye.');
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/transfer/:callLogId
 * TwiML that dials Hussein's number. Called by Twilio after callOrchestrator redirects the call.
 */
router.post('/transfer/:callLogId', twilioWebhookAuth, async (req: Request, res: Response) => {
  const env = getEnv();
  const callLogId = req.params.callLogId as string;

  const twiml = new VoiceResponse();
  const dial = twiml.dial({
    callerId: env.TWILIO_PHONE_NUMBER,
    timeout: 20,
    action: `${env.BASE_URL}/voice/transfer-status/${callLogId}`,
    method: 'POST',
  } as Parameters<typeof twiml.dial>[0]);
  dial.number(env.OWNER_PHONE_NUMBER);

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/transfer-status/:callLogId
 * Called by Twilio after <Dial> completes (any outcome).
 * If Hussein answered → let call end naturally. If no answer → tell caller + SMS Hussein.
 */
router.post('/transfer-status/:callLogId', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const env = getEnv();
  const callLogId = req.params.callLogId as string;
  const dialCallStatus = req.body.DialCallStatus as string;

  const twiml = new VoiceResponse();

  if (dialCallStatus !== 'completed') {
    twiml.say(
      { voice: 'Polly.Joanna' },
      "I wasn't able to reach Hussein directly. I'll make sure he gets your message and calls you back as soon as possible."
    );
    twiml.hangup();

    // Notify Hussein that the caller tried to reach him but got no answer
    try {
      const callLog = await getCallLogById(callLogId);
      const callerDisplay = callLog?.callerName || callLog?.fromNumber || req.body.From || 'Unknown caller';
      const callerNumber = callLog?.fromNumber || req.body.From || 'unknown';
      const body = `🚨 ${callerDisplay} tried to reach you but got no answer. Call them: ${callerNumber}`;
      await getTwilioClient().messages.create({
        body,
        from: env.TWILIO_PHONE_NUMBER,
        to: env.OWNER_PHONE_NUMBER,
      });
    } catch (err) {
      log.error({ callLogId, err }, 'Failed to send transfer no-answer SMS');
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/voicemail-transcription
 * Async callback with voicemail transcription.
 */
router.post('/voicemail-transcription', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const callSid = req.body.CallSid;
  const transcriptionText = req.body.TranscriptionText;
  const recordingSid = req.body.RecordingSid;

  log.info({ callSid, recordingSid, transcriptionText }, 'Voicemail transcription received');

  // TODO: Store transcription and send notification

  res.sendStatus(200);
});

export default router;
