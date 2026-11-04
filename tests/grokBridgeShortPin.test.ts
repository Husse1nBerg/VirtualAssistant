import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import WebSocket from 'ws';

const texts: string[] = [];
vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async ({ body }: { body: string }) => { texts.push(body); return { sid: 'SM1' }; } } }),
}));
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({ botRequest: { create: async ({ data }: { data: object }) => ({ id: 'req-1', ...data }), update: async () => {} } }),
  addTranscript: async () => {},
}));

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
    GROK_BOTS: JSON.stringify({ 'grok bot': { url: 'https://hooks.example/grok', key: 'crsr_main' } }),
    OWNER_PIN: '739',
  });
  (await import('../src/config/env')).loadEnv(); // would exit if a 3-digit PIN were refused
  (await import('../src/utils/logger')).initLogger('fatal');
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
});

beforeEach(async () => {
  (await import('../src/services/grokBridge')).resetPinFailuresForTests();
  texts.length = 0;
});

describe('a 3-digit PIN', () => {
  it('starts a bot command by text', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText('739 tell grok to say hello')).toBe("Sent to grok bot. I'll text you its answer.");
    expect(await handleOwnerText('738 tell grok to say hello')).toContain('Start bot commands with your PIN');
  });

  it('works spoken on a call, and Sky calls it a PIN', async () => {
    const { secretName } = await import('../src/services/grokBridge');
    expect(secretName()).toBe('PIN');
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    const s = { callId: 'c1', streamSid: 'MZ1', isCommandMode: true, transcriptParts: [] as unknown[], awaitingPin: true,
      twilioWs: { readyState: WebSocket.OPEN, send: vi.fn() } } as any;
    handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: 'Seven three nine.' });
    expect(s.pinOk).toBe(true);
  });

  it('locks for 24 hours after 5 wrong tries, not 1', async () => {
    const { checkPin } = await import('../src/services/grokBridge');
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(checkPin('111', 'sms', t0 + i)).toBe('wrong');
    await new Promise((r) => setTimeout(r, 0));
    expect(texts).toEqual(['Sky: 5 wrong PIN attempts by texts. Owner commands by texts are locked for 24 hours.']);
    expect(checkPin('739', 'sms', t0 + 2 * 3600_000)).toBe('locked');
    expect(checkPin('739', 'sms', t0 + 25 * 3600_000)).toBe('ok');
  });
});
