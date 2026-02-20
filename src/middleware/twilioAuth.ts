import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';

/**
 * Verifies Twilio webhook signatures to prevent unauthorized requests.
 * In development mode, verification can be skipped by not setting TWILIO_AUTH_TOKEN.
 */
export function twilioWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  const env = getEnv();
  const log = getLogger();

  if (env.NODE_ENV === 'development') {
    log.debug('Skipping Twilio webhook verification in development');
    next();
    return;
  }

  const signature = req.headers['x-twilio-signature'] as string;
  if (!signature) {
    log.warn({ requestId: req.requestId }, 'Missing Twilio signature header');
    res.status(403).json({ error: 'Missing signature' });
    return;
  }

  const url = `${env.BASE_URL}${req.originalUrl}`;
  const isValid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body || {}
  );

  if (!isValid) {
    log.warn({ requestId: req.requestId, url }, 'Invalid Twilio webhook signature');
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  next();
}
