import { Router, Request, Response } from 'express';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { twilioWebhookAuth } from '../middleware/twilioAuth';
import { getCallLogBySid, updateCallLog } from '../services/database';
import { sendRecordingOnlyNotification, sendSummaryOnlyFromCallLog } from '../services/notification';
import { getTwilioClient } from '../services/twilioClient';

const router = Router();

/** Start recording an in-progress call; callback URL receives RecordingUrl when done. */
async function startCallRecording(callSid: string): Promise<void> {
  const env = getEnv();
  const callbackUrl = `${env.BASE_URL}/voice/recording-status`;
  await getTwilioClient().calls(callSid).recordings.create({
    recordingStatusCallback: callbackUrl,
    recordingStatusCallbackEvent: ['completed'],
  });
  getLogger().info({ callSid }, 'Call recording started');
}

/**
 * POST /voice/inbound
 * Twilio hits this when a call comes in.
 * Returns TwiML that connects a Media Stream WebSocket.
 * On any error, returns TwiML that redirects to fallback (voicemail) so Twilio never plays "application error".
 */
router.post('/inbound', twilioWebhookAuth, (req: Request, res: Response) => {
  const log = getLogger();
  res.type('text/xml');

  try {
    const env = getEnv();
    const callSid = req.body.CallSid;
    const from = req.body.From || 'unknown';
    const to = req.body.To || 'unknown';

    log.info({ requestId: req.requestId, callSid, from, to }, 'Inbound call received');

    const twiml = new VoiceResponse();
    const wsUrl = env.BASE_URL.replace(/^http/, 'ws') + '/media-stream';

    const connect = twiml.connect();
    const stream = connect.stream({ url: wsUrl });
    stream.parameter({ name: 'from', value: from });
    stream.parameter({ name: 'to', value: to });
    stream.parameter({ name: 'callSid', value: callSid });

    // Start call recording (full conversation). Callback will save recording URL to call log.
    startCallRecording(callSid).catch((err) =>
      log.warn({ err, callSid }, 'Failed to start call recording')
    );

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
 */
router.post('/recording-status', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const callSid = req.body.CallSid;
  const recordingSid = req.body.RecordingSid;
  const recordingUrl = req.body.RecordingUrl;

  log.info({ callSid, recordingSid, recordingUrl }, 'Call recording ready');

  try {
    const callLog = await getCallLogBySid(callSid);
    if (callLog) {
      await updateCallLog(callLog.id, { recordingSid, recordingUrl });
      // Summary was already sent when the call ended; send recording only (link or MMS)
      sendRecordingOnlyNotification(callLog.id, recordingUrl).catch((err) =>
        log.error({ callSid, err }, 'Failed to send recording notification')
      );
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
              await sendSummaryOnlyFromCallLog(log);
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
