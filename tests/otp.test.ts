import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const texts: string[] = [];
const twilio = { failNext: false };
vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async ({ body }: { body: string }) => {
    if (twilio.failNext) { twilio.failNext = false; throw new Error('twilio down'); }
    texts.push(body);
    return { sid: 'SM1' };
  } } }),
}));
vi.mock('../src/services/database', () => ({ getPrisma: () => ({}) }));

const PHONE = 'phone-secret-0123456789abcdef0123456789abcdef';
const GROK = 'connector-secret-0123456789abcdef0123456789';
let server: Server;
let base: string;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
    BOT_CONNECTOR_SECRET: GROK, SMS_FORWARD_SECRET: PHONE,
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
  const express = (await import('express')).default;
  const app = express();
  app.use('/connector', (await import('../src/routes/connector')).default);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connector`;
});
afterAll(() => server.close());
beforeEach(async () => {
  (await import('../src/services/otpInbox')).clearCodesForTests();
  texts.length = 0;
});

const forward = (body: object | string, secret = PHONE) => fetch(`${base}/sms-code`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function getCode(from?: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'grok-bot-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${GROK}` } } }));
  const r = await client.callTool({ name: 'get_latest_code', arguments: from ? { from } : {} });
  await client.close();
  return (r.content as { text: string }[])[0].text;
}

describe('one-time codes from his iPhone', () => {
  it('finds the code in the usual formats', async () => {
    const { extractCode } = await import('../src/services/otpInbox');
    expect(extractCode('Your Amazon OTP is 482913. Do not share it.')).toBe('482913');
    expect(extractCode('G-731904 is your Google verification code.')).toBe('731904');
    expect(extractCode('Your code: 123-456')).toBe('123456');
    expect(extractCode('Use 9081 to sign in')).toBe('9081');
    expect(extractCode('Your package is on its way')).toBeNull();
    expect(extractCode('Amazon order 12345678: your code is 482913')).toBe('482913'); // not the order number
    expect(extractCode('Call 5145551234 or 4382221111 today')).toBeNull(); // can't tell which: no guess
  });

  it("only his phone can forward: wrong secret 401, Grok's secret is not enough", async () => {
    expect((await forward({ text: 'code 111111' }, 'x'.repeat(46))).status).toBe(401);
    expect((await forward({ text: 'code 111111' }, GROK)).status).toBe(401);
  });

  it('Grok gets the code once, and Hussein is told (without the code)', async () => {
    expect(await (await forward({ from: '32665', text: 'Your Amazon code is 482913' })).json()).toEqual({ ok: true, kept: true });
    const first = JSON.parse(await getCode('amazon')); // matched on the message: the sender is a short code
    expect(first).toEqual([expect.objectContaining({ from: '32665', code: '482913' })]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Grok Bot just read your one-time code');
    expect(texts[0]).not.toContain('482913');
    expect(await getCode('amazon')).toMatch(/^No new one-time code/); // read once
  });

  it('if the alert to Hussein fails, Grok gets no code and it stays for the next try', async () => {
    await forward({ from: 'Bank', text: 'Your code is 777333' });
    twilio.failNext = true;
    expect(await getCode('bank')).toMatch(/^Could not notify Hussein/);
    expect(JSON.parse(await getCode('bank'))[0].code).toBe('777333');
  });

  it('plain-text forwards work too, texts without a code are dropped, and codes expire after 10 minutes', async () => {
    expect(await (await forward('Your Uber code: 5521')).json()).toEqual({ ok: true, kept: true });
    expect(await (await forward({ text: 'Lunch at 1?' })).json()).toEqual({ ok: true, kept: false });
    const { addMessage, takeCodes } = await import('../src/services/otpInbox');
    addMessage('Bank', 'Your code is 999111', Date.now() - 11 * 60_000);
    expect(takeCodes('bank')).toEqual([]);
    expect(takeCodes('uber')[0].code).toBe('5521');
    expect(takeCodes('uber')).toEqual([]); // taken codes are gone, not just flagged
  });
});
