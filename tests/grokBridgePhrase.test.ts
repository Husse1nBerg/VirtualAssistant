import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import WebSocket from 'ws';

vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async () => ({ sid: 'SM1' }) } }),
}));
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({
    botRequest: { create: async ({ data }: { data: object }) => ({ id: 'req-1', ...data }), update: async () => {} },
    daySnapshot: { findUnique: async () => null },
  }),
  addTranscript: async () => {},
}));

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
    GROK_BOTS: JSON.stringify({ 'grok bot': { url: 'https://hooks.example/grok', key: 'crsr_main' } }),
    OWNER_PIN: 'Blue Falcon River',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
});

beforeEach(async () => {
  (await import('../src/services/grokBridge')).resetPinFailuresForTests();
});

describe('passphrase instead of a numeric PIN', () => {
  it('matches however it was spoken or typed', async () => {
    const { checkPin } = await import('../src/services/grokBridge');
    expect(checkPin('blue falcon river', 'call')).toBe('ok');
    expect(checkPin('Blue, falcon... river!', 'call')).toBe('ok');
    expect(checkPin('my passphrase is blue falcon river', 'call')).toBe('ok');
    expect(checkPin('red owl blue falcon river', 'call')).toBe('wrong'); // only the exact answer
    expect(checkPin('blue falcon', 'call')).toBe('wrong');
    expect(checkPin('blue falcon rivers', 'call')).toBe('wrong');
  });

  it('works at the start of a text', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText('Blue falcon river tell grok to say hello')).toBe("Sent to grok bot. I'll text you its answer.");
    expect(await handleOwnerText('tell grok to say hello')).toContain('Start bot commands with your PIN or passphrase');
  });

  it('is hidden in transcripts', async () => {
    const { maskPin } = await import('../src/services/grokBridge');
    expect(maskPin('Caller: Blue, falcon river.')).toBe('Caller: [PIN].');
    expect(maskPin('a blue falcon flew over the river')).toBe('a blue falcon flew over the river');
  });
});

describe('owner call: the passphrase is verified from his own words', () => {
  const session = () => ({ callId: 'c1', streamSid: 'MZ1', isCommandMode: true, transcriptParts: [] as unknown[],
    twilioWs: { readyState: WebSocket.OPEN, send: vi.fn() } }) as any;

  it('unlocks the call when he says it, whatever the AI later passes on', async () => {
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    const s = session();
    s.awaitingPin = true; // Sky has just asked for it
    handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: 'Blue falcon river.' });
    expect(s.pinOk).toBe(true);
    expect(s.transcriptParts[0].content).toBe('[PIN].');
  });

  it('does not unlock on a wrong phrase, or on the AI saying it', async () => {
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    const s = session();
    s.awaitingPin = true;
    handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: 'blue falcon' });
    handleAgentEvent(s, { type: 'ConversationText', role: 'assistant', content: 'blue falcon river' });
    expect(s.pinOk).toBeUndefined();
    expect(s.pinTries).toBe(1); // the wrong answer was counted
  });

  it('never unlocks from a run of guesses, or when Sky has not asked', async () => {
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    const s = session();
    handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: 'Blue falcon river' }); // not asked yet
    expect(s.pinOk).toBeUndefined();
    s.awaitingPin = true;
    handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: 'red owl lake blue falcon river green fox' });
    expect(s.pinOk).toBeUndefined();
  });
});

describe('schedule read aloud', () => {
  it('falls back to short sentences when Claude is unavailable', async () => {
    const { spokenSchedule } = await import('../src/services/grokBridge');
    expect(await spokenSchedule('6:00 PM - 7:00 PM: Sofia\n7:45 PM - 8:30 PM: Sammy'))
      .toBe('6:00 PM to 7:00 PM: Sofia. 7:45 PM to 8:30 PM: Sammy.');
  });
});

describe('talk while Sky waits for the passphrase', () => {
  it('is not counted as a wrong try, and the passphrase still works after it', async () => {
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    const s = { callId: 'c2', streamSid: 'MZ2', isCommandMode: true, transcriptParts: [] as unknown[], awaitingPin: true,
      twilioWs: { readyState: WebSocket.OPEN, send: vi.fn() } } as any;
    for (const said of ['And can you repeat that for me?', 'Okay. Connect to Grubbot.',
      'and then ask it to dispatch the teach works bot and complete a lesson for Steven today from six to eight']) {
      handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: said });
    }
    expect(s.pinTries).toBeUndefined();
    handleAgentEvent(s, { type: 'ConversationText', role: 'user', content: 'Blue falcon river.' });
    expect(s.pinOk).toBe(true);
  });
});
