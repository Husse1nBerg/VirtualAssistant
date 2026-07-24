import { describe, it, expect } from 'vitest';
import { computeUrgency, hasCallerSpeech } from '../src/services/urgency';
import type { Contact } from '../src/services/database';

function contact(alwaysUrgent: boolean, isVip = true): Contact {
  return {
    id: 'c1',
    phoneNumber: '+15145550000',
    name: 'Test',
    isVip,
    alwaysUrgent,
    notes: null,
    language: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Contact;
}

const caller = (content: string) => [{ role: 'caller', content }];

describe('computeUrgency', () => {
  it('scores a silent hang-up / no speech as low', () => {
    expect(computeUrgency('medium', null, [], 'Call ended with no caller speech detected.')).toBe('low');
    expect(computeUrgency('medium', null, [{ role: 'agent', content: 'Hi, how can I help?' }], '')).toBe('low');
  });

  it('scores a recorded conversation as medium', () => {
    expect(computeUrgency('medium', null, caller('Hi, can you tell Hussein I called about the invoice.'), '')).toBe('medium');
  });

  it('scores an alwaysUrgent contact (mom/dad/sisters) as high, even on a hang-up', () => {
    expect(computeUrgency('medium', contact(true), [], 'No speech detected.')).toBe('high');
    expect(computeUrgency('low', contact(true), caller('just checking in'), '')).toBe('high');
  });

  it('does NOT auto-flag a close (VIP) contact who is not alwaysUrgent', () => {
    // e.g. brother-in-law / best friend: high only if the transcript is urgent
    expect(computeUrgency('medium', contact(false, true), [], 'No speech detected.')).toBe('low');
    expect(computeUrgency('medium', contact(false, true), caller('just calling to say hi'), '')).toBe('medium');
    expect(computeUrgency('medium', contact(false, true), caller('this is an emergency'), '')).toBe('high');
  });

  it('scores urgent keywords as high (English + French)', () => {
    expect(computeUrgency('medium', null, caller('this is an emergency, please call back'), '')).toBe('high');
    expect(computeUrgency('medium', null, caller("I'm at the hospital"), '')).toBe('high');
    expect(computeUrgency('medium', null, caller("c'est une urgence"), '')).toBe('high');
  });

  it('respects an LLM-provided high even without keywords or VIP', () => {
    expect(computeUrgency('high', null, caller('the client is very upset'), '')).toBe('high');
  });

  it('does not over-flag ordinary messages', () => {
    expect(computeUrgency('medium', null, caller('Please let him know I will send the documents tomorrow.'), '')).toBe('medium');
  });
});

describe('hasCallerSpeech', () => {
  it('is false for empty or agent-only transcripts', () => {
    expect(hasCallerSpeech([])).toBe(false);
    expect(hasCallerSpeech([{ role: 'agent', content: 'Hello?' }])).toBe(false);
  });
  it('is true when the caller said something', () => {
    expect(hasCallerSpeech(caller('hello there'))).toBe(true);
  });
});
