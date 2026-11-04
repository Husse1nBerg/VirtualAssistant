/**
 * Photos passed between Hussein and his Grok bots.
 *
 * Sky downloads each photo once, keeps it in memory, and serves it at an unguessable
 * /connector/media/<id> link. Twilio pulls MMS photos from those links (instantly, from memory,
 * like recordings), and bots get links they can open without Twilio credentials.
 * A bot can send a photo as an https link, or as a data:image/...;base64 URL when its file is private.
 */
import { randomUUID } from 'crypto';
import { getEnv } from '../config';

// Twilio MMS: up to 10 media, about 5 MB per message in total.
export const MAX_PHOTOS = 10;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const TTL_MS = 24 * 3600_000; // long enough for a bot run to open what Hussein sent it
const MAX_STORED = 50;

// ponytail: in memory, single instance, lost on restart; the photos have already been delivered by then.
const store = new Map<string, { data: Buffer; type: string; expires: number }>();

export class PhotoError extends Error {}

async function download(src: string): Promise<{ data: Buffer; type: string }> {
  const dataUrl = src.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (dataUrl) return { type: dataUrl[1].toLowerCase(), data: Buffer.from(dataUrl[2], 'base64') };
  if (!src.startsWith('https://')) throw new PhotoError(`not an https link or data:image URL: ${src.slice(0, 60)}`);
  let res: Response;
  try {
    // Twilio credentials go only to Twilio (photos Hussein texted in), never to a bot-supplied host.
    const headers: Record<string, string> = new URL(src).hostname === 'api.twilio.com' ? { Authorization: twilioAuth() } : {};
    res = await fetch(src, { headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new PhotoError(`could not download ${src.slice(0, 100)}`);
  }
  if (!res.ok) throw new PhotoError(`${src.slice(0, 100)} answered HTTP ${res.status} (is it public?)`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new PhotoError(`${src.slice(0, 100)} is not an image (${type || 'no type'})`);
  return { type, data: Buffer.from(await res.arrayBuffer()) };
}

/** Downloads every photo (all or nothing) and returns Sky's own links to them. Throws PhotoError. */
export async function hostPhotos(sources: string[]): Promise<string[]> {
  if (sources.length > MAX_PHOTOS) throw new PhotoError(`at most ${MAX_PHOTOS} photos per message`);
  const photos = await Promise.all(sources.map((s) => download(s.trim())));
  const total = photos.reduce((n, p) => n + p.data.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new PhotoError(`photos total ${(total / 1048576).toFixed(1)} MB; a text holds at most 5 MB`);
  const now = Date.now();
  for (const [id, p] of store) if (p.expires < now) store.delete(id);
  return photos.map((p) => {
    const id = randomUUID();
    store.set(id, { ...p, expires: now + TTL_MS });
    while (store.size > MAX_STORED) store.delete(store.keys().next().value!);
    return `${getEnv().BASE_URL}/connector/media/${id}`;
  });
}

export function getPhoto(id: string): { data: Buffer; type: string } | undefined {
  const p = store.get(id);
  return p && p.expires > Date.now() ? p : undefined;
}

function twilioAuth(): string {
  const env = getEnv();
  return `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
}
