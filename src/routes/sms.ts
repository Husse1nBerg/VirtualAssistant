import { Router, Request, Response } from 'express';
import { getLogger } from '../utils/logger';
import { twilioWebhookAuth } from '../middleware/twilioAuth';
import { updateNotificationByMessageId } from '../services/database';
import { handleIncomingSms } from '../services/smsBrain';

const router = Router();

/**
 * POST /sms/inbound
 * Twilio webhook for inbound SMS messages.
 * Routes the message through the SMS brain for a conversational reply.
 */
router.post('/inbound', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const from = req.body.From as string;
  const to = req.body.To as string;
  const body = (req.body.Body as string || '').trim();

  log.info({ requestId: req.requestId, from, to, body: body.slice(0, 80) }, 'Inbound SMS received');

  // Return TwiML <Response><Message> to reply to the sender
  res.type('text/xml');

  if (!body) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hi, this is Hussein's assistant — what would you like me to pass along to him?</Message></Response>`);
  }

  try {
    const reply = await handleIncomingSms(from, body, to);
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
    );
  } catch (err) {
    log.error({ err, from }, 'SMS brain failed');
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>I'll make sure Hussein gets your message. Thanks for texting!</Message></Response>`
    );
  }
});

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * POST /sms/status
 * Twilio message status callback — delivery status for outbound SMS/MMS/WhatsApp.
 * Called when we pass statusCallback when creating messages.
 */
router.post('/status', twilioWebhookAuth, async (req: Request, res: Response) => {
  const log = getLogger();
  const messageSid = req.body.MessageSid;
  const messageStatus = req.body.MessageStatus;
  const errorCode = req.body.ErrorCode;

  log.info(
    { requestId: req.requestId, messageSid, messageStatus, errorCode },
    'Message status callback'
  );

  if (messageSid && messageStatus) {
    try {
      await updateNotificationByMessageId(messageSid, {
        status: messageStatus,
        error: errorCode ? String(errorCode) : undefined,
      });
    } catch (err) {
      log.error({ messageSid, err }, 'Failed to update notification status');
    }
  }

  res.sendStatus(200);
});

export default router;
