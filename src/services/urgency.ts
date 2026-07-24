import type { Contact } from './database';

export type Urgency = 'low' | 'medium' | 'high';

// Strong urgency signals. English + French, since some contacts are French speakers.
// Kept deliberately conservative — only phrases that genuinely imply "act now".
const URGENT_KEYWORDS = [
  'emergency', 'urgent', 'asap', 'as soon as possible', 'right away', 'immediately',
  'hospital', 'accident', '911', 'critical', 'life or death', "can't wait", 'cannot wait',
  // French
  'urgence', 'hôpital', 'hopital', 'accident', 'au secours', 'tout de suite',
];

interface TranscriptPart {
  role: string;
  content: string;
}

/** True when the caller actually said something — not a silent hang-up or wrong number. */
export function hasCallerSpeech(parts: TranscriptPart[]): boolean {
  return parts.some((p) => p.role === 'caller' && p.content.trim().length > 1);
}

/**
 * Final urgency for the post-call notification. Precedence (first match wins):
 *   1. VIP caller (inner circle) → high — Hussein wants to know they called.
 *   2. Urgent keyword in caller speech/summary, or the LLM already flagged high → high.
 *   3. No caller speech (hang-up / wrong number) → low.
 *   4. A real conversation was recorded → medium.
 *
 * @param base        Urgency proposed by the LLM summary (or fallback).
 * @param contact     Resolved caller contact, or null if unknown.
 * @param parts       Transcript parts captured during the call.
 * @param summaryText Free-text summary, also scanned for urgent keywords.
 */
export function computeUrgency(
  base: Urgency,
  contact: Contact | null,
  parts: TranscriptPart[],
  summaryText = ''
): Urgency {
  if (contact?.isVip) return 'high';

  const haystack = (
    parts.filter((p) => p.role === 'caller').map((p) => p.content).join(' ') +
    ' ' +
    summaryText
  ).toLowerCase();

  if (base === 'high' || URGENT_KEYWORDS.some((k) => haystack.includes(k))) return 'high';

  if (!hasCallerSpeech(parts)) return 'low';

  return 'medium';
}
