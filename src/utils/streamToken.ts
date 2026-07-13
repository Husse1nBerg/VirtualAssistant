import { createHmac, timingSafeEqual } from 'crypto';
import { getEnv } from '../config';

// Signed token proving a Media Stream connection was created by our own TwiML
// (via /voice/inbound), binding the callSid + mode so an attacker cannot connect
// directly to /media-stream and self-assign command mode. Signed with the Twilio
// auth token (already a server-only secret).

const TTL_MS = 5 * 60 * 1000; // token only needs to survive call setup

function sign(payload: string): string {
  return createHmac('sha256', getEnv().TWILIO_AUTH_TOKEN).update(payload).digest('hex');
}

export function mintStreamToken(callSid: string, mode: string): string {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(`${callSid}.${mode}.${exp}`)}`;
}

export function verifyStreamToken(
  token: string | undefined,
  callSid: string,
  mode: string
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || Date.now() > exp || !sig) return false;
  const expected = sign(`${callSid}.${mode}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
