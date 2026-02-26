/**
 * Health Alert Service
 *
 * Monitors for uncaught exceptions and unhandled promise rejections.
 * When a spike is detected (3+ errors in 5 minutes), sends a single
 * SMS alert to the owner — then backs off for 30 minutes before
 * sending another alert to avoid flood.
 *
 * Also exposes error counters so the /health endpoint can reflect them.
 */

import { getLogger } from '../utils/logger';
import { getEnv } from '../config';

// ── State ────────────────────────────────────────────

interface ErrorEvent {
  type: string;
  message: string;
  ts: number;
}

const recentErrors: ErrorEvent[] = [];
const ERROR_WINDOW_MS = 5 * 60 * 1000;    // 5-minute rolling window
const SPIKE_THRESHOLD = 3;                 // errors before alerting
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30-minute cooldown between alerts

let lastAlertAt = 0;
let totalErrors = 0;

// ── Helpers ──────────────────────────────────────────

function pruneOldErrors(): void {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  let i = 0;
  while (i < recentErrors.length && recentErrors[i].ts < cutoff) i++;
  if (i > 0) recentErrors.splice(0, i);
}

function recordError(type: string, message: string): void {
  totalErrors++;
  recentErrors.push({ type, message, ts: Date.now() });
  pruneOldErrors();

  const log = getLogger();
  log.warn({ type, message, recentCount: recentErrors.length }, 'Health alert: error recorded');

  if (
    recentErrors.length >= SPIKE_THRESHOLD &&
    Date.now() - lastAlertAt > ALERT_COOLDOWN_MS
  ) {
    lastAlertAt = Date.now();
    void sendAlert(type, message);
  }
}

async function sendAlert(type: string, lastMessage: string): Promise<void> {
  const log = getLogger();
  try {
    const env = getEnv();
    // Lazy import to avoid circular deps
    const { getTwilioClient } = await import('./twilioClient');
    const body = [
      `🚨 VirtualAssistant error spike detected`,
      `Type: ${type}`,
      `Last error: ${lastMessage.slice(0, 140)}`,
      `Count in last 5 min: ${recentErrors.length}`,
      `Total errors: ${totalErrors}`,
    ].join('\n');

    await getTwilioClient().messages.create({
      body,
      from: env.TWILIO_PHONE_NUMBER,
      to: env.OWNER_PHONE_NUMBER,
    });
    log.info({ type }, 'Health alert SMS sent');
  } catch (err) {
    log.error({ err }, 'Failed to send health alert SMS');
  }
}

// ── Public API ───────────────────────────────────────

export function getHealthStats() {
  pruneOldErrors();
  return {
    totalErrors,
    recentErrors: recentErrors.length,
    lastAlertAt: lastAlertAt > 0 ? new Date(lastAlertAt).toISOString() : null,
  };
}

/**
 * Register process-level error handlers.
 * Call once at startup after env is loaded.
 */
export function startHealthMonitor(): void {
  const log = getLogger();

  process.on('uncaughtException', (err: Error) => {
    log.error({ err }, 'Uncaught exception');
    recordError('uncaughtException', err.message);
    // Do NOT exit — let the server keep running after non-fatal errors
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    log.error({ reason }, 'Unhandled promise rejection');
    recordError('unhandledRejection', message);
  });

  log.info('Health monitor started');
}
