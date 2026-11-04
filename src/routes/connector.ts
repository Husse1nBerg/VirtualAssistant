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

const router = Router();

/** Bearer check in constant time. No secret configured = the connector does not exist (404). */
export function connectorAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = getEnv().BOT_CONNECTOR_SECRET;
  if (!secret) {
    res.sendStatus(404);
    return;
  }
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    getLogger().warn({ requestId: req.requestId }, 'Connector: rejected request with a bad secret');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

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
        "Replace Sky's copy of Hussein's schedule for today. Send the whole day, one item per line with times. Sky uses it to answer him instantly on calls and texts. Call it every morning and whenever today's plan changes.",
      inputSchema: { schedule: z.string().min(1).max(4000) },
    },
    async ({ schedule }) => {
      await setSchedule(schedule);
      return text("Saved as today's schedule.");
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

// Stateless servers have no event stream or session to end.
router.all('/mcp', connectorAuth, (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
});

export default router;
