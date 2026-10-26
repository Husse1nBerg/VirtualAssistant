/**
 * Daily agenda text.
 *
 * Every morning at AGENDA_HOUR (AGENDA_TIMEZONE) Sky merges three sources for the day:
 *   - the work calendar and Google Calendar, read from their private iCal links
 *   - items Hussein added by texting Sky ("add dentist Thursday 3pm")
 * Grok rewrites the list as a short text; Claude, then the plain list, are fallbacks,
 * so a morning text always goes out. It is sent from Sky's Twilio number to the owner.
 */

import ICAL from 'ical.js';
import * as chrono from 'chrono-node';
import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { getPrisma } from './database';
import { getTwilioClient } from './twilioClient';

export type AgendaSource = 'work' | 'google' | 'manual';

export interface AgendaEntry {
  title: string;
  start: Date;
  allDay: boolean;
  source: AgendaSource;
}

// ── Time zone helpers (no date library: Intl knows the IANA rules) ──────────

/** Minutes east of UTC for `tz` at instant `at` (Toronto in summer: -240). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/** The UTC instant of a wall-clock time in `tz`. Month is 1-12; overflowing days roll over. */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess - tzOffsetMinutes(new Date(first), tz) * 60_000);
}

/** YYYY-MM-DD of `at` as seen in `tz`. */
export function localDateKey(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Start and end (exclusive) of the local day `dayOffset` days after the day containing `now`. */
export function dayBounds(now: Date, tz: string, dayOffset = 0): { from: Date; to: Date; key: string } {
  const [y, m, d] = localDateKey(now, tz).split('-').map(Number);
  const from = zonedTimeToUtc(y, m, d + dayOffset, 0, 0, tz);
  const to = zonedTimeToUtc(y, m, d + dayOffset + 1, 0, 0, tz);
  return { from, to, key: localDateKey(from, tz) };
}

/** Milliseconds from `now` until the next `hour`:00 in `tz` (DST-safe). */
export function msUntilNext(hour: number, tz: string, now: Date): number {
  const [y, m, d] = localDateKey(now, tz).split('-').map(Number);
  let target = zonedTimeToUtc(y, m, d, hour, 0, tz);
  if (target.getTime() <= now.getTime()) target = zonedTimeToUtc(y, m, d + 1, hour, 0, tz);
  return target.getTime() - now.getTime();
}

// ── Calendar files ───────────────────────────────────────────────────────────

// ponytail: expansion walks from each series' first date; a daily series a decade old is
// ~3,650 steps, well under the guard. Add a start-date skip only if that ever shows in timing.
const MAX_OCCURRENCES = 20_000;

/** Events from one iCal file that fall on the local day [from, to), dayKey = its YYYY-MM-DD. */
export function eventsOnDay(ics: string, from: Date, to: Date, dayKey: string, source: AgendaSource): AgendaEntry[] {
  // TZIDs resolve against this file's own VTIMEZONE blocks (Outlook's "Eastern Standard
  // Time" included); tests/agenda.test.ts fails if that ever stops working.
  const root = new ICAL.Component(ICAL.parse(ics));

  const primaries = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(vevent);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else primaries.set(ev.uid, ev);
  }
  const orphans: ICAL.Event[] = [];
  for (const ex of exceptions) {
    const primary = primaries.get(ex.uid);
    if (primary) primary.relateException(ex);
    else orphans.push(ex);
  }

  const out: AgendaEntry[] = [];
  const consider = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null) => {
    if (String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    const title = (item.summary || '(no title)').trim();
    if (start.isDate) {
      // All-day: compare calendar dates, never instants. DTEND is exclusive.
      const s = start.toString().slice(0, 10);
      const e = end ? end.toString().slice(0, 10) : s;
      if (s <= dayKey && (dayKey < e || s === dayKey)) out.push({ title, start: from, allDay: true, source });
      return;
    }
    const s = start.toJSDate();
    const e = end ? end.toJSDate() : s;
    const zeroLength = e.getTime() <= s.getTime();
    if (zeroLength ? s >= from && s < to : s < to && e > from) out.push({ title, start: s, allDay: false, source });
  };

  for (const ev of [...primaries.values(), ...orphans]) {
    if (!ev.isRecurring()) {
      consider(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    let next: ICAL.Time | null;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
      // Past the day: stop (series are expanded in order).
      if (next.isDate ? next.toString().slice(0, 10) > dayKey : next.toJSDate() >= to) break;
      const d = ev.getOccurrenceDetails(next);
      consider(d.item, d.startDate, d.endDate);
    }
  }
  return out;
}

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`calendar returned ${res.status}`);
  return res.text();
}

// ── Building the day ─────────────────────────────────────────────────────────

export interface Agenda {
  dayKey: string;
  entries: AgendaEntry[];
  unreachable: string[]; // human names of sources that failed, so the text can say so
}

export async function buildAgenda(now: Date, dayOffset = 0): Promise<Agenda> {
  const env = getEnv();
  const log = getLogger();
  const tz = env.AGENDA_TIMEZONE;
  const { from, to, key } = dayBounds(now, tz, dayOffset);

  const calendars: { url: string; source: AgendaSource; name: string }[] = [
    { url: env.WORK_CALENDAR_ICS_URL, source: 'work', name: 'work calendar' },
    { url: env.GOOGLE_CALENDAR_ICS_URL, source: 'google', name: 'Google Calendar' },
  ];

  const entries: AgendaEntry[] = [];
  const unreachable: string[] = [];
  await Promise.all(calendars.filter((c) => c.url).map(async (c) => {
    try {
      entries.push(...eventsOnDay(await fetchIcs(c.url), from, to, key, c.source));
    } catch (err) {
      log.error({ err, source: c.source }, 'Agenda: calendar could not be read');
      unreachable.push(c.name);
    }
  }));

  const manual = await getPrisma().agendaItem.findMany({ where: { startsAt: { gte: from, lt: to } } });
  for (const m of manual) entries.push({ title: m.title, start: m.startsAt, allDay: m.allDay, source: 'manual' });

  entries.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
  return { dayKey: key, entries, unreachable };
}

export function formatTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
}

function formatDay(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** The plain list: always correct, used as-is when no AI is available. */
export function formatPlain(agenda: Agenda, tz: string, label = 'today'): string {
  const lines = agenda.entries.map((e) => `- ${e.allDay ? 'All day' : formatTime(e.start, tz)}: ${e.title}`);
  const head = `Your agenda for ${label}, ${formatDay(agenda.dayKey)}:`;
  const body = lines.length ? lines.join('\n') : 'Nothing scheduled.';
  const warn = agenda.unreachable.length ? `\n(Couldn't read your ${agenda.unreachable.join(' or ')} this time.)` : '';
  return `${head}\n${body}${warn}`;
}

// ── The morning brief ────────────────────────────────────────────────────────

const BRIEF_PROMPT = `Rewrite this agenda as a short, friendly morning text message to Hussein.
Rules: under 480 characters. Keep every item and its exact time as written (for example "3:00 PM").
Do not add, guess or drop anything. Plain text only, no markdown, no emoji. Start with "Morning."
If nothing is scheduled, say so in one line. If the agenda says a calendar couldn't be read, keep that warning.`;

async function askGrok(plain: string): Promise<string> {
  const env = getEnv();
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.XAI_MODEL,
      messages: [{ role: 'system', content: BRIEF_PROMPT }, { role: 'user', content: plain }],
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

async function askClaude(plain: string): Promise<string> {
  const client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    system: BRIEF_PROMPT,
    messages: [{ role: 'user', content: plain }],
  });
  const block = msg.content[0];
  return block && block.type === 'text' ? block.text.trim() : '';
}

/** An AI rewrite is used only if it kept every timed item's time; otherwise the plain list wins. */
export function keepsEveryTime(brief: string, agenda: Agenda, tz: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  const text = norm(brief);
  return agenda.entries.every((e) => {
    if (e.allDay) return true;
    const t = norm(formatTime(e.start, tz)); // "3:00 pm"
    return text.includes(t) || text.includes(t.replace(':00', ''));
  });
}

export async function writeBrief(agenda: Agenda): Promise<{ text: string; writer: 'grok' | 'claude' | 'plain' }> {
  const env = getEnv();
  const log = getLogger();
  const plain = formatPlain(agenda, env.AGENDA_TIMEZONE);
  const writers: ['grok' | 'claude', () => Promise<string>][] = [];
  if (env.XAI_API_KEY) writers.push(['grok', () => askGrok(plain)]);
  if (env.ANTHROPIC_API_KEY) writers.push(['claude', () => askClaude(plain)]);

  for (const [writer, ask] of writers) {
    try {
      const text = await ask();
      if (text && keepsEveryTime(text, agenda, env.AGENDA_TIMEZONE)) return { text, writer };
      log.warn({ writer }, 'Agenda: AI brief dropped or changed a time, trying the next writer');
    } catch (err) {
      log.error({ err, writer }, 'Agenda: AI brief failed, trying the next writer');
    }
  }
  return { text: plain, writer: 'plain' };
}

export async function sendDailyAgenda(now = new Date()): Promise<void> {
  const env = getEnv();
  const log = getLogger();
  const agenda = await buildAgenda(now);
  const { text, writer } = await writeBrief(agenda);
  const msg = await getTwilioClient().messages.create({ from: env.TWILIO_PHONE_NUMBER, to: env.OWNER_PHONE_NUMBER, body: text });
  log.info({ sid: msg.sid, items: agenda.entries.length, writer, unreachable: agenda.unreachable }, 'Daily agenda sent');
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

// ponytail: in-process timer, so a restart in the minute before AGENDA_HOUR skips that day's
// text. Render's starter plan stays up; add a "sent today" record if restarts ever cost a morning.
export function startAgendaScheduler(): void {
  const env = getEnv();
  if (!env.AGENDA_ENABLED) return;
  const log = getLogger();
  const schedule = () => {
    const wait = msUntilNext(env.AGENDA_HOUR, env.AGENDA_TIMEZONE, new Date());
    _timer = setTimeout(() => {
      sendDailyAgenda().catch((err) => log.error({ err }, 'Daily agenda failed')).finally(schedule);
    }, wait);
    _timer.unref();
    log.info({ inMinutes: Math.round(wait / 60_000) }, 'Daily agenda scheduled');
  };
  schedule();
}

export function stopAgendaScheduler(): void {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

// ── Owner text commands ──────────────────────────────────────────────────────

const lastTen = (n: string) => n.replace(/\D/g, '').slice(-10);
export function isOwnerNumber(from: string): boolean {
  return lastTen(from).length === 10 && lastTen(from) === lastTen(getEnv().OWNER_PHONE_NUMBER);
}

export interface ParsedAdd {
  title: string;
  startsAt: Date;
  allDay: boolean;
}

/** "dentist Thursday 3pm" -> { title: "dentist", startsAt: <Thu 15:00 local as UTC>, allDay: false }. */
export function parseAddCommand(text: string, now: Date, tz: string): ParsedAdd | null {
  const [result] = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(now, tz) }, { forwardDate: true });
  if (!result) return null;
  const s = result.start;
  const allDay = !s.isCertain('hour');
  // Rebuild from wall-clock parts in the IANA zone, so a date across a DST change is still right.
  const startsAt = zonedTimeToUtc(
    s.get('year')!, s.get('month')!, s.get('day')!,
    allDay ? 0 : s.get('hour')!, allDay ? 0 : s.get('minute') ?? 0, tz,
  );
  const title = (text.slice(0, result.index) + ' ' + text.slice(result.index + result.text.length))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(at|on|for|by)$/i, '')
    .replace(/^(at|on|for|by)\s+/i, '')
    .trim();
  return title ? { title, startsAt, allDay } : null;
}

function describe(item: { title: string; startsAt: Date; allDay: boolean }, tz: string): string {
  const day = formatDay(localDateKey(item.startsAt, tz));
  return `${item.title}, ${day}${item.allDay ? ' (all day)' : `, ${formatTime(item.startsAt, tz)}`}`;
}

const HELP = 'Agenda texts: "agenda", "tomorrow", "add dentist Thu 3pm", "remove dentist".';

/** Handles an agenda command from the owner. Returns the reply, or null if it isn't one. */
export async function handleOwnerAgendaCommand(body: string, now = new Date()): Promise<string | null> {
  const tz = getEnv().AGENDA_TIMEZONE;
  const text = body.trim();

  if (/^(agenda\s+)?help$/i.test(text)) return HELP;
  if (/^(agenda|today)$/i.test(text)) return formatPlain(await buildAgenda(now, 0), tz, 'today');
  if (/^tomorrow$/i.test(text)) return formatPlain(await buildAgenda(now, 1), tz, 'tomorrow');

  const add = text.match(/^add\s+(.+)/i);
  if (add) {
    const parsed = parseAddCommand(add[1], now, tz);
    if (!parsed) return 'I couldn\'t find a day or time in that. Try: "add dentist Thursday 3pm".';
    await getPrisma().agendaItem.create({ data: parsed });
    return `Added: ${describe(parsed, tz)}.`;
  }

  const remove = text.match(/^(remove|delete|cancel)\s+(.+)/i);
  if (remove) {
    const phrase = remove[2].toLowerCase();
    const upcoming = await getPrisma().agendaItem.findMany({
      where: { startsAt: { gte: dayBounds(now, tz).from } },
      orderBy: { startsAt: 'asc' },
    });
    const hit = upcoming.find((i) => i.title.toLowerCase().includes(phrase));
    if (!hit) return `I couldn't find an upcoming item matching "${remove[2]}".`;
    await getPrisma().agendaItem.delete({ where: { id: hit.id } });
    return `Removed: ${describe(hit, tz)}.`;
  }

  return null;
}
