import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The greeting is fetched by Twilio from the link in Sky's own TwiML. It must play for real calls,
// and refuse anyone who edits the link to make Sky say (and pay for) something else.
vi.mock('../src/services/database', () => ({
  createCallLog: async () => ({ id: 'log-1' }),
  getContactByPhone: async () => ({ name: 'Nada', isVip: true, language: 'fr' }),
  getCallLogBySid: async () => null, getCallLogById: async () => null,
  updateCallLog: async () => {}, markSummarySent: async () => true,
}));

const realFetch = globalThis.fetch;
let server: Server;
let base: string;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'production', PORT: '3000', BASE_URL: 'https://sky.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'auth-token-for-tests', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
  const express = (await import('express')).default;
  const voice = (await import('../src/routes/voice')).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/voice', voice);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function greetingLinkFromInbound(): Promise<string> {
  const twilio = (await import('twilio')).default;
  const params = { CallSid: 'CA1', From: '+15145550000', To: '+15551234567' };
  const signature = twilio.getExpectedTwilioSignature('auth-token-for-tests', 'https://sky.example/voice/inbound', params);
  const res = await realFetch(`${base}/voice/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params).toString(),
  });
  const xml = await res.text();
  const play = xml.match(/<Play>([^<]+)<\/Play>/)?.[1];
  if (!play) throw new Error(`no <Play> in TwiML: ${xml}`);
  return play.replace(/&amp;/g, '&').replace('https://sky.example', base);
}

describe('signed greeting link', () => {
  it("accepts the link from Sky's own TwiML", async () => {
    const link = await greetingLinkFromInbound();
    expect(link).toContain('s=');
    // The greeting then calls the TTS provider: answer that with fake audio.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      url.startsWith(base) ? realFetch(url, init) : new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const res = await realFetch(link);
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
  });

  it('refuses the link with the caller name changed, or with no signature', async () => {
    const link = await greetingLinkFromInbound();
    const tampered = link.replace(/caller=[^&]+/, 'caller=Free+money+call+now');
    expect(tampered).not.toBe(link);
    expect((await realFetch(tampered)).status).toBe(403);
    expect((await realFetch(`${base}/voice/greeting?caller=Anyone`)).status).toBe(403);
  });
});
