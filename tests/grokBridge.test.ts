import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// Fake database: relayToBot records requests; the connector's listing tool reads them.
const rows: Record<string, { status: string }> = {};
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({
    botRequest: {
      create: async ({ data }: { data: object }) => { const id = `req-${Object.keys(rows).length + 1}`; rows[id] = { status: 'sent' }; return { id, ...data }; },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => { rows[where.id].status = data.status; },
      findMany: async () => [],
    },
  }),
}));

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
    GROK_BOTS: JSON.stringify({
      'grok bot': { url: 'https://hooks.example/grok', key: 'crsr_main' },
      planner: { url: 'https://hooks.example/planner', key: 'crsr_plan' },
    }),
    BOT_CONNECTOR_SECRET: 'connector-secret-0123456789abcdef0123456789',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
});

describe('owner texts', () => {
  const names = ['grok bot', 'planner'];
  const cases: [string, unknown][] = [
    ['agenda', { kind: 'schedule' }],
    ['My day?', { kind: 'schedule' }],
    ['tell planner to move gym to 7', { kind: 'relay', bot: 'planner', command: 'move gym to 7' }],
    ['ask the planner bot: what is on Friday', { kind: 'relay', bot: 'planner', command: 'what is on Friday' }],
    ['Planner: cancel the dentist', { kind: 'relay', bot: 'planner', command: 'cancel the dentist' }],
    ['tell grok bot to book a table for 2', { kind: 'relay', bot: 'grok bot', command: 'book a table for 2' }],
    ['grok, remind me to call mom at 6', { kind: 'relay', bot: 'grok', command: 'remind me to call mom at 6' }],
    ['tell John I am late', null],
    ['hey, are you there?', null],
  ];
  it.each(cases)('%s', async (body, expected) => {
    const { parseOwnerText } = await import('../src/services/grokBridge');
    expect(parseOwnerText(body, names)).toEqual(expected);
  });

  it('matches bot names loosely and falls back to the main bot', async () => {
    const { resolveBot } = await import('../src/services/grokBridge');
    expect(resolveBot('Planner Bot')?.url).toBe('https://hooks.example/planner');
    expect(resolveBot('grok')?.name).toBe('grok bot');
    expect(resolveBot(undefined)?.name).toBe('grok bot');
    expect(resolveBot('accountant')).toBeNull();
  });

  it('recognises the owner only by the full number', async () => {
    const { isOwnerNumber } = await import('../src/services/grokBridge');
    expect(isOwnerNumber('+15149876543')).toBe(true);
    expect(isOwnerNumber('+445149876543')).toBe(false); // same 10 digits, other country
  });
});

describe('relaying to a bot', () => {
  it("starts the named bot's routine with its key, the command and the request id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); });
    const { relayToBot } = await import('../src/services/grokBridge');
    const { request, bot } = await relayToBot('planner', 'move gym to 7', 'call');
    vi.unstubAllGlobals();

    expect(bot.name).toBe('planner');
    expect(calls[0].url).toBe('https://hooks.example/planner');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer crsr_plan');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ request_id: request.id, command: 'move gym to 7' });
    expect(body.how_to_answer).toContain('reply_to_hussein');
    expect(rows[request.id].status).toBe('sent');
  });

  it('says so plainly when the bot is at its hourly limit, and marks the request failed', async () => {
    vi.stubGlobal('fetch', async () => new Response('Automation run rate limit exceeded', { status: 429 }));
    const { relayToBot } = await import('../src/services/grokBridge');
    await expect(relayToBot(undefined, 'anything', 'sms')).rejects.toThrow('grok bot is at its hourly limit');
    vi.unstubAllGlobals();
    expect(Object.values(rows).some((r) => r.status === 'failed')).toBe(true);
  });

  it('refuses a bot it does not know, naming the ones it does', async () => {
    const { relayToBot } = await import('../src/services/grokBridge');
    await expect(relayToBot('accountant', 'x', 'sms')).rejects.toThrow('Your bots: grok bot, planner');
  });
});

describe('Sky connector (what Grok Bot plugs into)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const connector = (await import('../src/routes/connector')).default;
    const app = express();
    app.use(express.json());
    app.use('/connector', connector);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connector/mcp`;
  });
  afterAll(() => server.close());

  it('rejects a wrong secret', async () => {
    const res = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('lets an MCP client with the secret list and call the tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'grok-bot-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { Authorization: 'Bearer connector-secret-0123456789abcdef0123456789' } },
    }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_pending_requests', 'reply_to_hussein', 'set_today_schedule', 'text_hussein']);
    const result = await client.callTool({ name: 'get_pending_requests', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: '[]' }]);
    await client.close();
  });
});
