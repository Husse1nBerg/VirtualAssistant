import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const sent: { body: string; mediaUrl?: string[] }[] = [];
vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async (m: { body: string; mediaUrl?: string[] }) => { sent.push(m); return { sid: 'SM1' }; } } }),
}));
vi.mock('../src/services/database', () => ({
  getPrisma: () => ({
    botRequest: {
      create: async ({ data }: { data: object }) => ({ id: 'req-1', ...data }),
      findUnique: async () => ({ id: 'req-1', botName: 'grok bot' }),
      update: async () => {},
    },
  }),
}));

const JPEG = Buffer.alloc(300_000, 7); // bigger than express's default 100 KB JSON limit once base64'd
const realFetch = globalThis.fetch;
const outside: { url: string; headers: Record<string, string>; body?: string }[] = [];

// Photo hosts and Twilio's media links (the address guard itself is tested below, for real).
vi.mock('../src/services/publicFetch', async (orig) => ({
  ...(await orig<typeof import('../src/services/publicFetch')>()),
  fetchPublic: async (url: string, opts: { headers?: Record<string, string> }) => {
    outside.push({ url, headers: opts.headers ?? {} });
    if (url.includes('/page.html')) return { status: 200, type: 'text/html', data: Buffer.from('<html>') };
    if (url.includes('/private')) return { status: 403, type: '', data: Buffer.alloc(0) };
    return { status: 200, type: 'image/jpeg', data: JPEG };
  },
}));

let server: Server;
let base: string;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://sky.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db',
    GROK_BOTS: JSON.stringify({ 'grok bot': { url: 'https://hooks.example/grok', key: 'crsr_main' } }),
    BOT_CONNECTOR_SECRET: 'connector-secret-0123456789abcdef0123456789',
    OWNER_PIN: '482913',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');

  // The bot webhook. Local calls (the MCP client, downloads from Sky) go through.
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    outside.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    return new Response('{}');
  });

  const express = (await import('express')).default;
  const connector = (await import('../src/routes/connector')).default;
  const app = express();
  app.use('/connector', connector);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connector`;
});
afterAll(() => server.close());
beforeEach(() => { sent.length = 0; outside.length = 0; });

async function callTool(name: string, args: object) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'grok-bot-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer connector-secret-0123456789abcdef0123456789' } },
  }));
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result as { content: { text: string }[]; isError?: boolean };
}

/** Sky's own link -> the bytes Twilio would download from it. */
async function download(link: string) {
  const res = await realFetch(link.replace('https://sky.example/connector', base));
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

describe('bot -> Hussein photos', () => {
  it('texts a private photo sent as base64, as an MMS Twilio can download', async () => {
    const r = await callTool('text_hussein', { message: 'Your receipt', photo_urls: [`data:image/jpeg;base64,${JPEG.toString('base64')}`] });
    expect(r.content[0].text).toBe('Texted to Hussein with 1 photo(s).');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('Your receipt');
    expect(sent[0].mediaUrl![0]).toMatch(/^https:\/\/sky\.example\/connector\/media\/[0-9a-f-]{36}$/);
    const got = await download(sent[0].mediaUrl![0]);
    expect(got).toMatchObject({ status: 200, type: 'image/jpeg' });
    expect(got.bytes.equals(JPEG)).toBe(true);
  });

  it('re-hosts a public link, without sending it any credentials', async () => {
    const r = await callTool('reply_to_hussein', { request_id: 'req-1', message: 'Done', photo_urls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] });
    expect(r.isError).toBeFalsy();
    expect(sent[0]).toMatchObject({ body: 'grok bot: Done' });
    expect(sent[0].mediaUrl).toHaveLength(2);
    expect(outside.every((o) => !('Authorization' in o.headers))).toBe(true);
  });

  it('sends nothing, and tells the bot why, when a photo cannot be used', async () => {
    for (const bad of ['https://cdn.example/private.jpg', 'https://cdn.example/page.html', 'http://cdn.example/a.jpg']) {
      const r = await callTool('text_hussein', { message: 'x', photo_urls: [bad] });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Nothing sent: /);
    }
    expect(sent).toHaveLength(0);
  });

  it('serves nothing for an unknown id', async () => {
    expect((await download('https://sky.example/connector/media/not-a-real-id')).status).toBe(404);
  });
});

describe('Hussein -> bot photos (MMS to Sky)', () => {
  it('passes his photos to the bot as links it can open', async () => {
    const { handleOwnerText } = await import('../src/services/grokBridge');
    const twilioMedia = 'https://api.twilio.com/2010-04-01/Accounts/ACx/Messages/MMx/Media/MEx';
    expect(await handleOwnerText('482913 grok: what plant is this?', [twilioMedia])).toBe("Sent to grok bot with your photo. I'll text you its answer.");
    // Twilio's link is fetched with the account credentials...
    expect(outside[0]).toMatchObject({ url: twilioMedia, headers: { Authorization: expect.stringMatching(/^Basic /) } });
    // ...and the bot gets Sky's link instead, which needs none.
    const hook = outside.find((o) => o.url === 'https://hooks.example/grok')!;
    const payload = JSON.parse(hook.body!);
    expect(payload.command).toBe('what plant is this?');
    expect(payload.photos[0]).toMatch(/^https:\/\/sky\.example\/connector\/media\//);
    expect((await download(payload.photos[0])).bytes.equals(JPEG)).toBe(true);
  });
});

describe('links a bot hands Sky reach only the public internet', () => {
  it('knows private and internal addresses', async () => {
    const { isPublicAddress } = await import('../src/services/publicFetch');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses localhost, internal IPs and plain http before connecting', async () => {
    const { fetchPublic } = await vi.importActual<typeof import('../src/services/publicFetch')>('../src/services/publicFetch');
    for (const url of ['https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/a.jpg', 'http://example.com/a.jpg']) {
      await expect(fetchPublic(url, { maxBytes: 1000 }), url).rejects.toThrow(/not a public address|only https/);
    }
  });
});
