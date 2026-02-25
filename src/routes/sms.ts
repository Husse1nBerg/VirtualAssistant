import { Router, Request, Response } from 'express';
import { getLogger } from '../utils/logger';
import { twilioWebhookAuth } from '../middleware/twilioAuth';
import { updateNotificationByMessageId } from '../services/database';

const router = Router();

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
