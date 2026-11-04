/**
 * One-time codes from Hussein's phone, for his Grok bot's browser.
 *
 *   iPhone Shortcuts ("When I get a message containing 'code'") -> POST /connector/sms-code
 *   Grok Bot -> connector tool get_latest_code -> the code, once
 *
 * Codes are second factors, so: memory only (never the database, never logs), gone after
 * 10 minutes, each readable once, and Hussein gets a text every time one is read.
 */

const TTL_MS = 10 * 60_000;
const MAX_KEPT = 20;

// `text`: the start of the message, so a filter like "amazon" works when the sender is a short code.
interface Code { from: string; text: string; code: string; at: number; read: boolean }
// ponytail: in memory, single instance; a restart drops pending codes, which simply expire anyway.
const inbox: Code[] = [];

/** "123456", "123-456", "123 456" or "G-123456"; null if the text holds no code. */
export function extractCode(text: string): string | null {
  const split = text.match(/(?<![\d-])(\d{3})[- ](\d{3})(?![\d-])/);
  if (split) return split[1] + split[2];
  return text.match(/(?<!\d)\d{4,8}(?!\d)/)?.[0] ?? null;
}

/** A forwarded text. Returns whether it held a code (only codes are kept, not the message). */
export function addMessage(from: string, text: string, now = Date.now()): boolean {
  const code = extractCode(text);
  if (!code) return false;
  inbox.push({ from: from.trim().slice(0, 60) || 'unknown', text: text.trim().slice(0, 160), code, at: now, read: false });
  while (inbox.length > MAX_KEPT) inbox.shift();
  return true;
}

/** Unread codes from the last 10 minutes, newest first, optionally only from a matching sender.
 *  Reading marks them read: a code is handed out once. */
export function takeCodes(filter = '', now = Date.now()): { from: string; message: string; code: string; secondsAgo: number }[] {
  const want = filter.trim().toLowerCase();
  const fresh = inbox
    .filter((c) => !c.read && now - c.at < TTL_MS && (!want || `${c.from} ${c.text}`.toLowerCase().includes(want)))
    .sort((a, b) => b.at - a.at);
  for (const c of fresh) c.read = true;
  return fresh.map((c) => ({ from: c.from, message: c.text, code: c.code, secondsAgo: Math.round((now - c.at) / 1000) }));
}

export function clearCodesForTests(): void {
  inbox.length = 0;
}
