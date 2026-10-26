import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const texts: string[] = [];
vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async ({ body }: { body: string }) => { texts.push(body); return { sid: 'SM1' }; } } }),
}));
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({
    botRequest: { create: async ({ data }: { data: object }) => ({ id: 'req-1', ...data }), update: async () => {} },
    daySnapshot: { findUnique: async () => ({ text: '9:30 standup', updatedAt: new Date() }) },
  }),
}));

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
    GROK_BOTS: JSON.stringify({ 'grok bot': { url: 'https://hooks.example/grok', key: 'crsr_main' } }),
    OWNER_PIN: '4321',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
});

beforeEach(async () => {
  (await import('../src/services/grokBridge')).resetPinFailuresForTests();
  texts.length = 0;
});

describe('owner texts with a PIN set', () => {
  it('relays only when the text starts with the PIN', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText('4321 grok, remind me at 6')).toBe("Sent to grok bot. I'll text you its answer.");
    expect(await handleOwnerText('grok, remind me at 6')).toContain('Start bot commands with your PIN');
    expect(await handleOwnerText('1111 grok, remind me at 6')).toContain('Start bot commands with your PIN');
  });

  it('guards the schedule too', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText('agenda')).toContain('Start bot commands with your PIN');
    expect(await handleOwnerText('4321 agenda')).toBe('9:30 standup');
  });

  it('leaves ordinary texts alone', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText('hey, call me back')).toBeNull();
  });

  it('locks for an hour after 5 wrong PINs and texts Hussein once', async () => {
    const { checkPin } = await import('../src/services/grokBridge');
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(checkPin('0000', t0 + i)).toBe('wrong');
    expect(checkPin('4321', t0 + 10)).toBe('locked'); // even the right PIN, during the lock
    await new Promise((r) => setTimeout(r, 0));
    expect(texts).toEqual(['Sky: 5 wrong PIN attempts in the last hour. Bot commands are locked for an hour.']);
    expect(checkPin('4321', t0 + 61 * 60_000)).toBe('ok'); // lock expires
  });
});
