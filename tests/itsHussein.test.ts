import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';

// A fake Deepgram/Twilio socket: records what Sky sends and lets the test fire its events.
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
  }
  const h = { FakeWs, agents: [] as InstanceType<typeof FakeWs>[], db: { updateCallLog: [] as unknown[], summaryClaimed: [] as string[] }, notified: [] as string[] };
  return h;
});
vi.mock('ws', () => ({ WebSocket: h.FakeWs, default: h.FakeWs }));

const texts: string[] = [];
vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async ({ body }: { body: string }) => { texts.push(body); return { sid: 'SM1' }; } } }),
}));
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({
    botRequest: { create: async ({ data }: { data: object }) => ({ id: 'req-1', ...data }), update: async () => {} },
    daySnapshot: { findUnique: async () => ({ text: '9:30 standup', updatedAt: new Date() }) },
  }),
  addTranscript: async () => {},
  updateCallLog: async (_id: string, data: unknown) => { h.db.updateCallLog.push(data); },
  markSummarySent: async (id: string) => { h.db.summaryClaimed.push(id); return true; },
  getCallLogBySid: async () => ({ id: 'call-9', reasonForCall: 'Voice commands', fromNumber: '+15550001111' }),
  getCallLogById: async () => null,
  createCallLog: async () => ({ id: 'call-9' }),
  getContactByPhone: async () => null,
  getContactByNameOrPhone: async () => null,
  getRecentCallsByNumber: async () => [],
}));
vi.mock('../src/services/notification', () => ({
  sendCombinedCallNotification: async () => { h.notified.push('combined'); },
  sendRecordingOnlyNotification: async () => { h.notified.push('recording'); },
  sendSummaryOnlyFromCallLog: async () => { h.notified.push('summary'); },
  sendEscalationSMS: async () => {},
  sendSMSToRecipient: async () => {},
}));
vi.mock('../src/services/recordingCache', () => ({
  prefetchRecording: async () => { h.notified.push('prefetch'); },
  getCachedRecording: () => undefined,
  fetchRecordingMp3: async () => Buffer.alloc(0),
}));

const realFetch = globalThis.fetch;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'file:./test.db',
    GROK_BOTS: JSON.stringify({ 'grok bot': { url: 'https://hooks.example/grok', key: 'crsr_main' } }),
    OWNER_PIN: '482913',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 })); // the bot webhook
});

beforeEach(async () => {
  (await import('../src/services/grokBridge')).resetPinFailuresForTests();
  h.agents.length = 0;
  h.db.updateCallLog.length = 0;
  h.db.summaryClaimed.length = 0;
  h.notified.length = 0;
  texts.length = 0;
});

/** A stranger call already talking to the message-taking agent. */
async function strangerCall() {
  const { openAgent } = await import('../src/services/callOrchestrator');
  const twilio = new h.FakeWs();
  const s = { callId: 'call-9', callSid: 'CA9', streamSid: 'MZ9', fromNumber: '+15550001111', toNumber: '+15551234567',
    twilioWs: twilio, agentWs: null, startTime: Date.now(), ended: false, transcriptParts: [], summary: null,
    contact: null, isCommandMode: false, callerCtx: { contact: null, recentCalls: [] } } as any;
  openAgent(s, { stranger: true });
  return { s, twilio, first: h.agents[0] };
}
const say = async (s: unknown, content: string) =>
  (await import('../src/services/callOrchestrator')).handleAgentEvent(s as never, { type: 'ConversationText', role: 'user', content });
const fnNames = (settings: { agent: { think: { functions: { name: string }[] } } }) => settings.agent.think.functions.map((f) => f.name);

describe('call: "it\'s Hussein" from another phone', () => {
  it('swaps to the owner agent, which greets him, and keeps the call up', async () => {
    const { s, twilio, first } = await strangerCall();
    await say(s, "Hi, it's Hussein.");

    expect(h.agents).toHaveLength(2);
    const settings = h.agents[1].settings();
    expect(settings.agent.greeting).toBe('Hi Hussein, what can I do for you?');
    expect(settings.agent.context).toBeUndefined(); // the stranger greeting is not replayed as history
    expect(fnNames(settings)).toEqual(['relay_to_bot', 'get_today_schedule', 'send_sms', 'not_hussein']);
    expect(s.isCommandMode).toBe(true);
    expect(s.agentWs).toBe(h.agents[1]);
    expect(first.readyState).toBe(3); // old agent closed...
    expect(s.ended).toBe(false);      // ...without ending the call
    expect(twilio.sent.some((m) => JSON.parse(m).event === 'clear')).toBe(true); // old agent's audio dropped
  });

  it('still asks for his PIN before doing anything', async () => {
    const { s } = await strangerCall();
    await say(s, "It's Hussein");
    const owner = h.agents[1];
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    handleAgentEvent(s, { type: 'FunctionCallRequest', functions: [{ id: 'f1', name: 'relay_to_bot', arguments: '{"command":"say hello"}' }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(owner.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'FunctionCallResponse')?.output).toBe("What's your PIN?");
    expect(texts).toHaveLength(0);
    await say(s, 'four eight two nine one three');
    expect(s.pinOk).toBe(true);
  });

  it('recognises how speech-to-text spells his name, and nothing else', async () => {
    const { claimsToBeOwner } = await import('../src/services/grokBridge');
    for (const t of ["It's Hussein.", 'this is Hussain', 'Hey, it’s Husein', 'Hussein here', "I'm Hussein, can you hear me?"]) expect(claimsToBeOwner(t), t).toBe(true);
    for (const t of ['Is this Hussein?', "I'm calling for Hussein", "It's Hussein's friend", 'Hussein said to call', 'Can I speak to Hussein'])
      expect(claimsToBeOwner(t), t).toBe(false);
  });
});

describe('call: a stranger is never stuck as Hussein', () => {
  it('"Hussein\'s friend" keeps taking a message', async () => {
    const { s } = await strangerCall();
    await say(s, "It's Hussein's friend Sam, he told me to call.");
    expect(h.agents).toHaveLength(1);
    expect(s.isCommandMode).toBe(false);
  });

  it('a different Hussein (not_hussein) goes back to message-taking', async () => {
    const { s } = await strangerCall();
    await say(s, "It's Hussein");
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    handleAgentEvent(s, { type: 'FunctionCallRequest', functions: [{ id: 'f2', name: 'not_hussein', arguments: '{}' }] });
    expect(h.agents).toHaveLength(3);
    const settings = h.agents[2].settings();
    expect(settings.agent.greeting).toBe('No problem. What would you like me to pass along to Hussein?');
    expect(fnNames(settings)).toContain('end_call_summary');
    expect(fnNames(settings)).not.toContain('relay_to_bot');
    expect(s.isCommandMode).toBe(false);
    expect(s.ended).toBe(false);
  });

  it('not_hussein does nothing on a call that never claimed', async () => {
    const { s } = await strangerCall();
    const { handleAgentEvent } = await import('../src/services/callOrchestrator');
    handleAgentEvent(s, { type: 'FunctionCallRequest', functions: [{ id: 'f3', name: 'not_hussein', arguments: '{}' }] });
    expect(h.agents).toHaveLength(1);
  });
});

describe('text: "it\'s Hussein"', () => {
  const OTHER = '+15550001111';
  it('asks for the PIN, then makes him admin: plain texts go to his bot without the PIN', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText("hey it's Hussein", [], OTHER)).toBe('Hi Hussein. Text your PIN to continue.');
    expect(await handleOwnerText('482913', [], OTHER)).toBe('Hi Hussein, what can I do for you?');
    expect(await handleOwnerText('remind me to call mom at 6', [], OTHER)).toBe("Sent to grok bot. I'll text you its answer.");
    expect(await handleOwnerText('agenda', [], OTHER)).toBe('9:30 standup');
    expect(await handleOwnerText('lock', [], OTHER)).toContain('Locked');
    expect(await handleOwnerText('remind me again', [], OTHER)).toBeNull(); // locked: back to a normal stranger text
  });

  it('a wrong PIN gets no access, and a stranger who is not Hussein just carries on', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText("it's Hussein", [], OTHER)).toBe('Hi Hussein. Text your PIN to continue.');
    expect(await handleOwnerText('111111', [], OTHER)).toBe("That didn't match. Text your PIN again.");
    expect(await handleOwnerText('Sorry, wrong Hussein. Please tell him the plumber called.', [], OTHER)).toBeNull();
    expect(await handleOwnerText('Hello, this is the dentist', [], OTHER)).toBeNull();
  });

  it('runs the command he typed before the PIN once he gives it', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    expect(await handleOwnerText('tell grok to book a table')).toBe('Hi Hussein. Text your PIN to continue.');
    expect(await handleOwnerText('482913')).toBe("Sent to grok bot. I'll text you its answer.");
  });

  it('the admin session ends after 15 quiet minutes', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    const t0 = Date.now();
    expect(await handleOwnerText("it's Hussein", [], OTHER, t0)).toContain('Text your PIN');
    expect(await handleOwnerText('482913', [], OTHER, t0 + 1000)).toBe('Hi Hussein, what can I do for you?');
    expect(await handleOwnerText('remind me later', [], OTHER, t0 + 16 * 60_000)).toBeNull();
  });

  it('his own number never reaches the stranger routine (smsBrain)', async () => {
    const { handleIncomingSms } = await import('../src/services/smsBrain');
    expect(await handleIncomingSms('+15149876543', 'hey are you there', '+15551234567')).toBe('Hi Hussein. Text your PIN to continue.');
  });
});

describe('summary: his admin calls are not messages', () => {
  it('an unverified "it\'s Hussein" call is still summarised to him (no hiding a call behind his name)', async () => {
    const { s } = await strangerCall();
    await say(s, "It's Hussein");
    h.agents[1].close();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ended).toBe(true);
    expect(h.db.summaryClaimed).toEqual([]);
    expect(h.db.updateCallLog).not.toContainEqual(expect.objectContaining({ reasonForCall: 'Voice commands' }));
  });

  it('ending an admin call claims the summary, so no "new message" text goes out', async () => {
    const { s } = await strangerCall();
    await say(s, "It's Hussein");
    s.pinOk = true; // he gave his PIN
    h.agents[1].close(); // the live agent hangs up: the call ends
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ended).toBe(true);
    expect(h.db.updateCallLog).toContainEqual(expect.objectContaining({ reasonForCall: 'Voice commands', callerName: 'Owner' }));
    expect(h.db.summaryClaimed).toEqual(['call-9']);
  });

  it('the recording of an admin call is not texted to him', async () => {
    const express = (await import('express')).default;
    const voice = (await import('../src/routes/voice')).default;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/voice', voice);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const res = await realFetch(`http://127.0.0.1:${port}/voice/recording-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CA9&RecordingSid=RE9&RecordingUrl=https%3A%2F%2Fapi.twilio.com%2Frec%2FRE9',
    }).finally(() => server.close());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.notified).toEqual([]);
  });
});
