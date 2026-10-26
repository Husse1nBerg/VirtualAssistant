import { describe, it, expect } from 'vitest';
import {
  dayBounds,
  eventsOnDay,
  formatPlain,
  keepsEveryTime,
  msUntilNext,
  parseAddCommand,
  type Agenda,
} from '../src/services/agenda';

const TZ = 'America/Toronto';

// Outlook-style calendar: Windows zone name, weekday standup with one moved and one skipped
// occurrence, an all-day event, a cancelled meeting, a UTC (Google-style) event.
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VTIMEZONE', 'TZID:Eastern Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3', 'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:standup', 'SUMMARY:Standup',
  'DTSTART;TZID=Eastern Standard Time:20260105T093000', 'DTEND;TZID=Eastern Standard Time:20260105T094500',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'EXDATE;TZID=Eastern Standard Time:20261027T093000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:standup', 'RECURRENCE-ID;TZID=Eastern Standard Time:20261026T093000', 'SUMMARY:Standup (moved)',
  'DTSTART;TZID=Eastern Standard Time:20261026T110000', 'DTEND;TZID=Eastern Standard Time:20261026T111500', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:bday', 'SUMMARY:Ali birthday', 'DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261027', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:cancelled', 'SUMMARY:Old meeting', 'STATUS:CANCELLED',
  'DTSTART:20261026T180000Z', 'DTEND:20261026T190000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:dentist', 'SUMMARY:Dentist', 'DTSTART:20261026T190000Z', 'DTEND:20261026T200000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:tue', 'SUMMARY:Tuesday thing', 'DTSTART:20261027T150000Z', 'DTEND:20261027T160000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function day(isoNoon: string) {
  const b = dayBounds(new Date(isoNoon), TZ);
  return eventsOnDay(ICS, b.from, b.to, b.key, 'work').map((e) => [e.title, e.allDay ? 'all-day' : e.start.toISOString()]);
}

describe('agenda calendar reading', () => {
  it('Monday: moved standup, all-day birthday, dentist; skips the cancelled meeting and other days', () => {
    expect(day('2026-10-26T16:00:00Z').sort()).toEqual([
      ['Ali birthday', 'all-day'],
      ['Dentist', '2026-10-26T19:00:00.000Z'],
      ['Standup (moved)', '2026-10-26T15:00:00.000Z'],
    ]);
  });

  it('Tuesday: the skipped standup does not appear', () => {
    expect(day('2026-10-27T16:00:00Z')).toEqual([['Tuesday thing', '2026-10-27T15:00:00.000Z']]);
  });

  it('keeps 9:30 local across the daylight-saving change', () => {
    expect(day('2026-10-28T16:00:00Z')).toEqual([['Standup', '2026-10-28T13:30:00.000Z']]); // EDT
    expect(day('2026-11-02T16:00:00Z')).toEqual([['Standup', '2026-11-02T14:30:00.000Z']]); // EST
  });
});

describe('agenda timing', () => {
  it('waits until 7:00 local today when it is earlier', () => {
    expect(msUntilNext(7, TZ, new Date('2026-10-26T10:00:00Z'))).toBe(60 * 60_000); // 6:00 EDT
  });

  it('lands on 7:00 local the morning daylight saving ends', () => {
    // Sat Oct 31 8:00 EDT -> Sun Nov 1 7:00 EST: 24 h of real time.
    expect(msUntilNext(7, TZ, new Date('2026-10-31T12:00:00Z'))).toBe(24 * 60 * 60_000);
  });
});

describe('agenda "add" texts', () => {
  const now = new Date('2026-10-26T13:00:00Z'); // Monday 9:00 EDT

  it('reads a weekday and time', () => {
    expect(parseAddCommand('dentist Thursday 3pm', now, TZ)).toEqual({
      title: 'dentist', startsAt: new Date('2026-10-29T19:00:00Z'), allDay: false,
    });
  });

  it('makes an item with no time all-day', () => {
    expect(parseAddCommand('call the garage tomorrow', now, TZ)).toEqual({
      title: 'call the garage', startsAt: new Date('2026-10-27T04:00:00Z'), allDay: true,
    });
  });

  it('uses standard time for a date after the change', () => {
    expect(parseAddCommand('dentist Nov 3 at 3pm', now, TZ)).toEqual({
      title: 'dentist', startsAt: new Date('2026-11-03T20:00:00Z'), allDay: false,
    });
  });

  it('refuses text with no date', () => {
    expect(parseAddCommand('buy milk', now, TZ)).toBeNull();
  });
});

describe('agenda text', () => {
  const agenda: Agenda = {
    dayKey: '2026-10-26',
    entries: [
      { title: 'Ali birthday', start: new Date('2026-10-26T04:00:00Z'), allDay: true, source: 'google' },
      { title: 'Standup', start: new Date('2026-10-26T15:00:00Z'), allDay: false, source: 'work' },
      { title: 'Dentist', start: new Date('2026-10-26T19:00:00Z'), allDay: false, source: 'manual' },
    ],
    unreachable: ['work calendar'],
  };

  it('formats the plain list in local time and flags an unreadable calendar', () => {
    expect(formatPlain(agenda, TZ)).toBe(
      'Your agenda for today, Mon, Oct 26:\n- All day: Ali birthday\n- 11:00 AM: Standup\n- 3:00 PM: Dentist\n' +
      "(Couldn't read your work calendar this time.)",
    );
  });

  it('rejects an AI rewrite that loses a time', () => {
    expect(keepsEveryTime('Morning. Standup at 11 AM, dentist at 3:00 PM.', agenda, TZ)).toBe(true);
    expect(keepsEveryTime('Morning. Standup at 11 AM, then the dentist.', agenda, TZ)).toBe(false);
  });
});
