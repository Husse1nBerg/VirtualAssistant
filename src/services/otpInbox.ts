/**
 * One-time codes from Hussein's phone, for his Grok bot's browser.
 *
 *   iPhone Shortcuts ("When I get a message containing 'code'") -> POST /connector/sms-code
 *   Grok Bot -> connector tool get_latest_code -> the code, once
 *
 * Codes are second factors, so: memory only (never the database, never logs), deleted when read
 * or after 10 minutes, and Hussein gets a text every time one is read.
 */

const TTL_MS = 10 * 60_000;
const MAX_KEPT = 20;

// `text`: the start of the message, so a filter like "amazon" works when the sender is a short code.
export interface Code { from: string; text: string; code: string; at: number }
// ponytail: in memory, single instance; a restart drops pending codes, which simply expire anyway.
let inbox: Code[] = [];
const prune = (now: number) => { inbox = inbox.filter((c) => now - c.at < TTL_MS); };

const CANDIDATE = /(?<![\d-])(\d{3})[- ](\d{3})(?![\d-])|(?<!\d)(\d{4,8})(?!\d)/g;
const OTP_WORDS = /\b(?:code|codes|otp|pin|passcode|verification|verify|password|token)\b/gi;

/** The one-time code in a text: "123456", "123-456", "123 456" or "G-123456". With several numbers
 *  (an order number and a code), the one closest to a word like "code" or "OTP" wins; if it is
 *  still unclear, null rather than a wrong guess. */
export function extractCode(text: string): string | null {
  const nums = [...text.matchAll(CANDIDATE)].map((m) => ({ code: m[3] ?? m[1] + m[2], at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  if (nums.length <= 1) return nums[0]?.code ?? null;
  const words = [...text.matchAll(OTP_WORDS)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  if (!words.length) return null;
  // Characters between the number and the word, whichever side it is on ("code is 482913", "482913 is your code").
  const dist = (n: { at: number; end: number }) => Math.min(...words.map((w) => (w.start >= n.end ? w.start - n.end : Math.max(0, n.at - w.end))));
  const ranked = nums.map((n) => ({ ...n, d: dist(n) })).sort((a, b) => a.d - b.d);
  return ranked[0].d < ranked[1].d && ranked[0].d <= 40 ? ranked[0].code : null;
}

/** A forwarded text. Returns whether it held a code (only texts with a code are kept). */
export function addMessage(from: string, text: string, now = Date.now()): boolean {
  prune(now);
  const code = extractCode(text);
  if (!code) return false;
  inbox.push({ from: from.trim().slice(0, 60) || 'unknown', text: text.trim().slice(0, 160), code, at: now });
  while (inbox.length > MAX_KEPT) inbox.shift();
  return true;
}

/** Codes from the last 10 minutes, newest first, optionally only those matching a sender or word.
 *  They are removed: a code is handed out once (putBack undoes it if the hand-out fails). */
export function takeCodes(filter = '', now = Date.now()): Code[] {
  prune(now);
  const want = filter.trim().toLowerCase();
  const taken = inbox.filter((c) => !want || `${c.from} ${c.text}`.toLowerCase().includes(want));
  inbox = inbox.filter((c) => !taken.includes(c));
  return taken.sort((a, b) => b.at - a.at);
}

export function putBack(codes: Code[]): void {
  inbox.push(...codes);
}

export function clearCodesForTests(): void {
  inbox = [];
}
