/**
 * Sky's connector for Grok Bot: a remote MCP server at POST /connector/mcp.
 * Added in Grok Bot as a custom MCP server with header  Authorization: Bearer <BOT_CONNECTOR_SECRET>.
 *
 * Every tool acts only toward Hussein (text him, answer his request, update his schedule):
 * there is deliberately no tool that texts or calls anyone else.
 */

import express, { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { deliverReply, textOwner, setSchedule, pendingRequests } from '../services/grokBridge';
import { hostPhotos, getPhoto, PhotoError, MAX_PHOTOS } from '../services/mediaStore';
import { addMessage, takeCodes, putBack } from '../services/otpInbox';

const router = Router();

/** Bearer check in constant time. No secret configured = the endpoint does not exist (404). */
function bearerAuth(secretOf: () => string, label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = secretOf();
    if (!secret) {
      res.sendStatus(404);
      return;
    }
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      getLogger().warn({ requestId: req.requestId }, `${label}: rejected request with a bad secret`);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export const connectorAuth = bearerAuth(() => getEnv().BOT_CONNECTOR_SECRET, 'Connector');
const smsForwardAuth = bearerAuth(() => getEnv().SMS_FORWARD_SECRET, 'SMS forward');

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const photoUrls = z
  .array(z.string().min(1))
  .max(MAX_PHOTOS)
  .optional()
  .describe('Photos to text him: https links Sky can download, or data:image/...;base64 URLs for private files. 5 MB total.');

/** Downloads the photos first, so a bad link fails the call before anything is texted. */
async function withPhotos(urls: string[] | undefined, send: (photos: string[]) => Promise<string>) {
  try {
    return text(await send(urls?.length ? await hostPhotos(urls) : []));
  } catch (err) {
    if (err instanceof PhotoError) return { ...text(`Nothing sent: ${err.message}.`), isError: true };
    throw err;
  }
}

export function buildConnectorServer(): McpServer {
  const server = new McpServer({ name: 'sky', version: '1.0.0' });

  server.registerTool(
    'reply_to_hussein',
    {
      description:
        'Answer a request Sky relayed to you. Use the request_id from the request Sky sent you. Sky texts the message to Hussein, and says it aloud if he is on a call. Keep it to one or two sentences.',
      inputSchema: { request_id: z.string().min(1), message: z.string().min(1).max(1500), photo_urls: photoUrls },
    },
    async ({ request_id, message, photo_urls }) => withPhotos(photo_urls, (photos) => deliverReply(request_id, message, photos)),
  );

  server.registerTool(
    'text_hussein',
    {
      description: "Send Hussein a text from Sky's number (his daily agenda, a reminder, an update you start yourself), with photos if you have any.",
      inputSchema: { message: z.string().min(1).max(1500), photo_urls: photoUrls },
    },
    async ({ message, photo_urls }) =>
      withPhotos(photo_urls, async (photos) => {
        await textOwner(message, photos);
        return photos.length ? `Texted to Hussein with ${photos.length} photo(s).` : 'Texted to Hussein.';
      }),
  );

  server.registerTool(
    'set_today_schedule',
    {
      description:
        "Replace Sky's copy of Hussein's schedule: today plus the coming weeks (as far ahead as you know), one item per line with its date and times. Sky reads it to Hussein, and tells callers only whether he is free or busy at a time they ask about. Call it every morning and whenever his plans change.",
      inputSchema: { schedule: z.string().min(1).max(4000) },
    },
    async ({ schedule }) => {
      await setSchedule(schedule);
      return text("Saved as today's schedule.");
    },
  );

  server.registerTool(
    'get_latest_code',
    {
      description:
        "A one-time code just texted to Hussein's phone (his iPhone forwards them to Sky). Call it after a site sends him a verification code. " +
        'Optionally pass a word to match the service or sender (e.g. "amazon"). Codes are kept 10 minutes and each can be read once; Hussein is texted whenever one is read.',
      inputSchema: { from: z.string().max(60).optional() },
    },
    async ({ from }) => {
      const codes = takeCodes(from ?? '');
      if (!codes.length) return text('No new one-time code in the last 10 minutes. Wait a few seconds after the site sends it, then try again.');
      const sources = [...new Set(codes.map((c) => c.from))].join(', ');
      // Hussein is always told: no alert, no code (it stays for the next try).
      try {
        await textOwner(`Sky: Grok Bot just read your one-time code (from ${sources}). If that wasn't you, secure that account.`);
      } catch (err) {
        putBack(codes);
        getLogger().error({ err }, 'One-time code: could not alert Hussein, code kept back');
        return { ...text('Could not notify Hussein, so the code was not released. Try again in a moment.'), isError: true };
      }
      const now = Date.now();
      return text(JSON.stringify(codes.map((c) => ({ from: c.from, message: c.text, code: c.code, secondsAgo: Math.round((now - c.at) / 1000) }))));
    },
  );

  server.registerTool(
    'get_pending_requests',
    {
      description: 'List requests Hussein sent through Sky in the last 24 hours that have not been answered yet.',
      inputSchema: {},
    },
    async () => text(JSON.stringify(await pendingRequests())),
  );

  return server;
}

// Stateless: a fresh server and transport per request, JSON responses, no sessions.
// Photos travel as base64 in tool calls, so the connector takes bigger bodies, but only once authenticated.
router.post('/mcp', connectorAuth, express.json({ limit: '8mb' }), async (req: Request, res: Response) => {
  const server = buildConnectorServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    getLogger().error({ err }, 'Connector: request failed');
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
});

// Photos in transit (Twilio MMS and bots download these). Unguessable ids, gone after a day.
router.get('/media/:id', (req: Request, res: Response) => {
  const photo = getPhoto(req.params.id as string);
  if (!photo) return void res.sendStatus(404);
  res.set({ 'Content-Type': photo.type, 'Cache-Control': 'private, max-age=86400' }).send(photo.data);
});

// His iPhone (Shortcuts: "When I get a message containing 'code'") forwards the text here.
// Only a code found in it is kept; the text and code are never logged.
router.post('/sms-code', smsForwardAuth, express.json({ limit: '10kb' }), express.text({ limit: '10kb', type: 'text/*' }), (req: Request, res: Response) => {
  const body = req.body as unknown;
  const text = typeof body === 'string' ? body : typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text : '';
  const from = typeof (body as { from?: unknown })?.from === 'string' ? (body as { from: string }).from : '';
  const kept = addMessage(from, text);
  getLogger().info({ requestId: req.requestId, kept }, 'SMS forward: message received');
  res.json({ ok: true, kept });
});

// Stateless servers have no event stream or session to end.
router.all('/mcp', connectorAuth, (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
});

export default router;
