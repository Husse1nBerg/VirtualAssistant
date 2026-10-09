// Why this exists: Twilio pulls the MMS audio from our /voice/recording/:id proxy right
// after we create the message. Twilio message timestamps showed that when that first
// pull is slow (fresh recording, mp3 transcoded on demand + full proxy download), Twilio
// gives up and retries on a backoff schedule — 1 to 18 minutes before the text arrives.
// Fix: fetch the mp3 BEFORE creating the message and serve it from memory, so the proxy
// answers Twilio instantly.
import { getEnv } from '../config';

// ponytail: in-memory, single instance; move to disk/redis only if we ever scale past one dyno.
const TTL_MS = 15 * 60_000;
const cache = new Map<string, Buffer>();

export function fetchRecordingMp3(recordingUrl: string): Promise<Buffer> {
  const env = getEnv();
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  // Twilio's RecordingUrl has no extension — append .mp3 to get audio (bare URL returns XML metadata).
  const mp3Url = recordingUrl.replace(/\.(mp3|wav|ogg)$/, '') + '.mp3';
  return fetch(mp3Url, { headers: { Authorization: `Basic ${auth}` }, redirect: 'follow' }).then(async (res) => {
    if (!res.ok) throw new Error(`Twilio recording fetch failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
}

export async function prefetchRecording(callLogId: string, recordingUrl: string): Promise<void> {
  cache.set(callLogId, await fetchRecordingMp3(recordingUrl));
  setTimeout(() => cache.delete(callLogId), TTL_MS).unref();
}

export function getCachedRecording(callLogId: string): Buffer | undefined {
  return cache.get(callLogId);
}
