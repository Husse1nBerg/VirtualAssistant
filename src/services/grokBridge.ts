/**
 * Grok Bot link: an open channel between Sky and Hussein's Grok bots.
 *
 *   Hussein -> Sky (call or text) -> POST to the named bot's routine webhook -> the run starts at once
 *   bot -> Sky connector (MCP tool reply_to_hussein) -> Sky texts Hussein, or says it if he's on a call
 *
 * Commands that name no bot go to GROK_DEFAULT_BOT ("grok bot"), which dispatches to its sub-bots.
 * Bots also keep Sky's copy of today's schedule fresh (set_today_schedule), so Sky can answer
 * "what's my afternoon?" instantly, and can text Hussein directly (text_hussein) for the daily agenda.
 */

import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { getPrisma } from './database';
import { getTwilioClient } from './twilioClient';

// ── Bot directory ────────────────────────────────────────────────────────────

/** A bot's routine webhook, copied from the routine's Webhook section in Grok Bot. */
export interface BotHook {
  url: string; // the "POST to" address
  key: string; // sent as Authorization: Bearer <key>
}

export interface Bot extends BotHook {
  name: string;
}

/** GROK_BOTS as name -> webhook, names lower-cased. Bad JSON or entries are logged and skipped. */
export function botDirectory(): Map<string, BotHook> {
  try {
    const raw = JSON.parse(getEnv().GROK_BOTS) as Record<string, Partial<BotHook>>;
    const dir = new Map<string, BotHook>();
    for (const [name, hook] of Object.entries(raw)) {
      if (typeof hook?.url === 'string' && hook.url.startsWith('https://') && typeof hook.key === 'string' && hook.key) {
        dir.set(name.trim().toLowerCase().replace(/\s+/g, ' '), { url: hook.url, key: hook.key });
      } else {
        getLogger().error({ bot: name }, 'GROK_BOTS entry needs an https url and a key; skipped');
      }
    }
    return dir;
  } catch (err) {
    getLogger().error({ err }, 'GROK_BOTS is not valid JSON; no bots configured');
    return new Map();
  }
}

/** "Planner bot", "planner" and "PLANNER" all find "planner"; "grok" finds "grok bot". */
export function resolveBot(name: string | undefined, dir = botDirectory()): Bot | null {
  const want = (name?.trim() || getEnv().GROK_DEFAULT_BOT).toLowerCase().replace(/\s+/g, ' ');
  for (const candidate of [want, want.replace(/ bot$/, ''), `${want} bot`]) {
    const hook = dir.get(candidate);
    if (hook) return { name: candidate, ...hook };
  }
  return null;
}

// ── Owner text parsing ───────────────────────────────────────────────────────

export type OwnerText =
  | { kind: 'schedule' }
  | { kind: 'relay'; bot?: string; command: string };

/**
 * Recognises the owner's bridge texts. Anything else returns null and keeps its old behaviour.
 *   "agenda" / "today" / "my day"            -> today's schedule
 *   "tell planner to move gym to 7"          -> planner
 *   "ask the planner bot: what's tomorrow?"  -> planner
 *   "planner: move gym to 7"                 -> planner
 *   "grok, remind me to call mom at 6"       -> default bot
 */
export function parseOwnerText(body: string, botNames: string[]): OwnerText | null {
  const text = body.trim();
  if (/^(agenda|today|my day|schedule)\??$/i.test(text)) return { kind: 'schedule' };

  // Longest name first, so "grok bot" wins over "grok". Each name also matches without " bot".
  const names = [...new Set(botNames.flatMap((n) => [n, n.replace(/ bot$/, '')]))].sort((a, b) => b.length - a.length);
  const command = (rest: string) => rest.replace(/^(?:\s*bot\b)?\s*(?:to\b|:|,)?\s*/i, '').trim();
  const lead = (s: string) => names.find((n) => s.toLowerCase().startsWith(n) && /^(?:\s|:|,|$)/.test(s.slice(n.length)));

  const ask = text.match(/^(?:tell|ask)\s+(?:the\s+|my\s+)?(.+)$/is);
  if (ask) {
    const name = lead(ask[1]);
    if (name) {
      const cmd = command(ask[1].slice(name.length));
      return cmd ? { kind: 'relay', bot: name, command: cmd } : null;
    }
    const grok = ask[1].match(/^grok\b(.*)$/is);
    if (grok && command(grok[1])) return { kind: 'relay', command: command(grok[1]) };
    return null; // "tell John I'm late" is not for a bot
  }

  const prefixed = lead(text);
  if (prefixed && /^\s*[:,]/.test(text.slice(prefixed.length))) {
    const cmd = command(text.slice(prefixed.length));
    if (cmd) return { kind: 'relay', bot: prefixed, command: cmd };
  }

  const grok = text.match(/^grok\s*[:,]\s*(.+)$/is);
  if (grok) return { kind: 'relay', command: grok[1].trim() };
  return null;
}

// ── Relay out: Sky -> bot (POST to the bot's routine webhook) ────────────────

export class BridgeError extends Error {}

/** The JSON body the routine receives along with its standing instruction. */
export function relayPayload(id: string, command: string, channel: 'call' | 'sms') {
  return {
    request_id: id,
    from: `Hussein, via Sky (${channel === 'call' ? 'phone call' : 'text message'})`,
    command,
    how_to_answer:
      `When done, call the Sky connector tool reply_to_hussein with request_id "${id}" and a one or ` +
      'two sentence result. Sky reads it aloud if he is on a call, and texts it to him.',
  };
}

/** Records the request and starts the bot's routine. Throws BridgeError with a sentence fit to say aloud. */
export async function relayToBot(botName: string | undefined, command: string, channel: 'call' | 'sms') {
  const env = getEnv();
  const bot = resolveBot(botName);
  if (!bot) {
    const known = [...botDirectory().keys()].join(', ') || 'none yet';
    throw new BridgeError(`I don't have a bot called ${botName ?? env.GROK_DEFAULT_BOT}. Your bots: ${known}.`);
  }
  const prisma = getPrisma();
  const request = await prisma.botRequest.create({ data: { botName: bot.name, command, channel } });
  let res: Response;
  try {
    res = await fetch(bot.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bot.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(relayPayload(request.id, command, channel)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    await prisma.botRequest.update({ where: { id: request.id }, data: { status: 'failed' } });
    getLogger().error({ err, bot: bot.name }, 'Grok bridge: webhook unreachable');
    throw new BridgeError(`I couldn't reach ${bot.name} just now. Try again in a minute.`);
  }
  // 200 means the run started (not finished); the answer comes back through the connector.
  if (!res.ok) {
    await prisma.botRequest.update({ where: { id: request.id }, data: { status: 'failed' } });
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    getLogger().error({ bot: bot.name, status: res.status, detail }, 'Grok bridge: webhook refused the request');
    throw new BridgeError(
      res.status === 429
        ? `${bot.name} is at its hourly limit. Try again in a bit.`
        : `${bot.name} didn't accept that (error ${res.status}). Its webhook key may have changed.`,
    );
  }
  getLogger().info({ requestId: request.id, bot: bot.name, channel }, 'Grok bridge: routine started');
  return { request, bot };
}

// ── Relay back: bot -> Sky -> Hussein ────────────────────────────────────────

export async function textOwner(message: string): Promise<void> {
  const env = getEnv();
  await getTwilioClient().messages.create({
    from: env.TWILIO_PHONE_NUMBER,
    to: env.OWNER_PHONE_NUMBER,
    body: message.slice(0, 1500),
  });
}

// The call orchestrator registers how to speak to Hussein if he's on a call (avoids an import cycle).
let _sayOnLiveCall: ((text: string) => boolean) | null = null;
export function onLiveOwnerCall(fn: (text: string) => boolean): void {
  _sayOnLiveCall = fn;
}

/** A bot's answer: stored, texted to Hussein, and spoken too if he's on a call with Sky. */
export async function deliverReply(requestId: string, message: string): Promise<string> {
  const prisma = getPrisma();
  const request = await prisma.botRequest.findUnique({ where: { id: requestId } });
  if (!request) return `No request with id ${requestId}.`;
  await prisma.botRequest.update({ where: { id: requestId }, data: { status: 'done', reply: message, repliedAt: new Date() } });
  const line = `${request.botName}: ${message}`;
  const spoken = _sayOnLiveCall?.(`Update from ${line}`) ?? false;
  await textOwner(line);
  getLogger().info({ requestId, bot: request.botName, spoken }, 'Grok bridge: reply delivered');
  return spoken ? 'Delivered: texted to Hussein and told him on his call.' : 'Delivered: texted to Hussein.';
}

export async function pendingRequests() {
  return getPrisma().botRequest.findMany({
    where: { status: 'sent', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, botName: true, command: true, channel: true, createdAt: true },
  });
}

// ── Today's schedule (kept fresh by the bots) ────────────────────────────────

export async function setSchedule(text: string): Promise<void> {
  await getPrisma().daySnapshot.upsert({ where: { id: 'today' }, create: { id: 'today', text }, update: { text } });
}

/** The schedule as a sentence-ready string, flagged if it wasn't updated today. */
export async function describeSchedule(now = new Date()): Promise<string> {
  const snap = await getPrisma().daySnapshot.findUnique({ where: { id: 'today' } });
  if (!snap) return "Your bots haven't sent me a schedule yet.";
  const tz = getEnv().OWNER_TIMEZONE;
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  if (day(snap.updatedAt) === day(now)) return snap.text;
  const when = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(snap.updatedAt);
  return `I only have the schedule from ${when}, nothing newer: ${snap.text}`;
}

// ── Owner identity and texts ─────────────────────────────────────────────────

// Exact full-number match, country code included (Twilio sends E.164).
const allDigits = (n: string) => n.replace(/\D/g, '');
export function isOwnerNumber(from: string): boolean {
  const owner = allDigits(getEnv().OWNER_PHONE_NUMBER);
  return owner.length >= 8 && allDigits(from) === owner;
}

/** The owner's bridge texts. Returns the reply, or null to fall through to the normal SMS flow. */
export async function handleOwnerText(body: string): Promise<string | null> {
  const parsed = parseOwnerText(body, [...botDirectory().keys()]);
  if (!parsed) return null;
  if (parsed.kind === 'schedule') return describeSchedule();
  try {
    const { bot } = await relayToBot(parsed.bot, parsed.command, 'sms');
    return `Sent to ${bot.name}. I'll text you its answer.`;
  } catch (err) {
    return err instanceof BridgeError ? err.message : 'Something went wrong sending that. Try again.';
  }
}
