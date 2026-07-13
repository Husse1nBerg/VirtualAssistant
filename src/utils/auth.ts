import { timingSafeEqual } from 'crypto';
import { getEnv } from '../config';

/** Constant-time check of a candidate dashboard token against DASHBOARD_TOKEN. */
export function isValidDashboardToken(candidate: unknown): boolean {
  const expected = getEnv().DASHBOARD_TOKEN;
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Replace the dashboard token with *** wherever it appears in a URL, for safe logging. */
export function redactUrl(url: string): string {
  const t = getEnv().DASHBOARD_TOKEN;
  return t && url.includes(t) ? url.split(t).join('***') : url;
}
