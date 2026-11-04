import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Fake Deepgram/Twilio sockets (same harness as itsHussein.test.ts).
const h = vi.hoisted(() => {
  class FakeWs {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent: string[] = [];
    handlers: Record<string, (...a: unknown[]) => void> = {};
    constructor(public url = 'twilio') { if (url.startsWith('wss://agent.deepgram.com')) h.agents.push(this); }
    on(e: string, f: (...a: unknown[]) => void) { this.handlers[e] = f; return this; }
    send(d: unknown) { this.sent.push(String(d)); }
    close() { this.readyState = 3; this.handlers.close?.(1000, Buffer.from('')); }
    settings() { this.handlers.open?.(); return JSON.parse(this.sent[0]); }
    emit(event: object) { this.handlers.message?.(Buffer.from(JSON.stringify(event))); }
  }
  const h = { FakeWs, agents: [] as InstanceType<typeof FakeWs>[] };
  return h;
});
vi.mock('ws', () => ({ WebSocket: h.FakeWs, default: h.FakeWs }));
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({}),
  addTranscript: async () => {},
  updateCallLog: async () => {},
  markSummarySent: async () => true,
  getCallLogBySid: async () => null,
  createCallLog: async () => ({ id: 'call-1' }),
  getContactByPhone: async () => null,
  getContactByNameOrPhone: async () => null,
  getRecentCallsByNumber: async () => [],
}));

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'file:./test.db',
    TTS_PROVIDER: 'deepgram',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
});
beforeEach(() => { h.agents.length = 0; });

async function strangerCall() {
  const { openAgent } = await import('../src/services/callOrchestrator');
  const s = { callId: 'call-1', callSid: 'CA1', streamSid: 'MZ1', fromNumber: '+15550001111', toNumber: '+15551234567',
    twilioWs: new h.FakeWs(), agentWs: null, startTime: Date.now(), ended: false, transcriptParts: [] as { role: string; content: string }[],
    summary: null, contact: null, isCommandMode: false, callerCtx: { contact: null, recentCalls: [] } } as any;
  openAgent(s, { stranger: true });
  return s;
}
const say = async (s: unknown, role: string, content: string) =>
  (await import('../src/services/callOrchestrator')).handleAgentEvent(s as never, { type: 'ConversationText', role, content });

describe('French is detected from what the caller says', () => {
  it('switches on French, never on English or a lone ambiguous word', async () => {
    const { looksFrench } = await import('../src/services/agentPrompt');
    for (const t of ['Oui, je dois.', 'Bonjour!', "Je voudrais laisser un message pour Hussein", "C'est Abed, est-ce qu'il est disponible jeudi?"])
      expect(looksFrench(t), t).toBe(true);
    for (const t of ['Hi, is Hussein available?', 'Merci', 'Le Château restaurant at six', 'OK, sounds good', 'I want to have dinner with my son'])
      expect(looksFrench(t), t).toBe(false);
  });
});

describe('call: the caller switches to French', () => {
  it('reopens Sky in French, keeps the conversation, and answers what they just said', async () => {
    const s = await strangerCall();
    await say(s, 'assistant', "Hi, I'm Sky, Hussein's assistant!");
    await say(s, 'user', 'Hello, is Hussein there?');
    expect(h.agents).toHaveLength(1);
    await say(s, 'user', 'Oui, je voudrais laisser un message pour lui.');

    expect(h.agents).toHaveLength(2);
    expect(s.ended).toBe(false);
    expect(h.agents[0].readyState).toBe(3);
    const fr = h.agents[1];
    const settings = fr.settings();
    expect(settings.agent.speak.provider.model).toBe('aura-2-agathe-fr'); // French voice
    expect(settings.agent.listen.provider.language_hints[0]).toBe('fr');
    expect(settings.agent.think.prompt).toContain('LANGUAGE OVERRIDE');
    const history = settings.agent.context.messages.map((m: { content: string }) => m.content);
    expect(history).toContain('Hello, is Hussein there?');
    expect(history).not.toContain('Oui, je voudrais laisser un message pour lui.'); // re-sent instead

    fr.emit({ type: 'SettingsApplied' });
    expect(fr.sent.map((m) => JSON.parse(m))).toContainEqual({ type: 'InjectUserMessage', content: 'Oui, je voudrais laisser un message pour lui.' });
    // Deepgram echoes the injected line back: not recorded twice, and no second switch.
    const before = s.transcriptParts.length;
    await say(s, 'user', 'Oui, je voudrais laisser un message pour lui.');
    expect(s.transcriptParts.length).toBe(before);
    await say(s, 'user', 'Merci, à bientôt!');
    expect(h.agents).toHaveLength(2);
  });

  it('a saved French contact is already in French: no switch', async () => {
    const s = await strangerCall();
    s.callerCtx = { contact: { name: 'Nada', language: 'fr', isVip: false }, recentCalls: [] };
    await say(s, 'user', 'Oui, je voudrais laisser un message.');
    expect(h.agents).toHaveLength(1);
  });

  it('availability answers come in French for a French caller', async () => {
    const { describeDay, parseDayBlocks } = await import('../src/services/grokBridge');
    const blocks = parseDayBlocks('{"covered":true,"blocks":[{"start":"09:00","end":"17:00","kind":"work"},{"start":"17:00","end":"18:00","kind":"tutoring"},{"start":"18:15","end":"19:15","kind":"tutoring"}]}');
    expect(describeDay(blocks as never, 'fr')).toBe(
      'Ce jour-là, il est au travail de 9 h à 17 h, puis en tutorat de 17 h à 19 h 15, sans pause. Il est libre après 19 h 15.');
  });
});
