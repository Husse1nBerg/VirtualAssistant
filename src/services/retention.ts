/**
 * Data Retention Service
 *
 * When DATA_RETENTION_DAYS > 0, automatically deletes CallLog records
 * (and their cascaded Transcript + NotificationLog children) older than
 * the configured number of days.
 *
 * The purge runs once on server startup and then every 24 hours.
 */

import { getEnv } from '../config';
import { getLogger } from '../utils/logger';
import { deleteOldCallLogs } from './database';

let _timer: ReturnType<typeof setInterval> | null = null;

async function runPurge(): Promise<void> {
  const env = getEnv();
  const days = env.DATA_RETENTION_DAYS;
  if (days <= 0) return;

  const log = getLogger();
  try {
    const deleted = await deleteOldCallLogs(days);
    if (deleted > 0) {
      log.info({ deleted, retentionDays: days }, 'Data retention: deleted old call logs');
    } else {
      log.debug({ retentionDays: days }, 'Data retention: no records to delete');
    }
  } catch (err) {
    log.error({ err }, 'Data retention: purge failed');
  }
}

/**
 * Start the retention scheduler.
 * Call once from server startup. Safe to call multiple times (idempotent).
 */
export function startRetentionScheduler(): void {
  const env = getEnv();
  if (env.DATA_RETENTION_DAYS <= 0) return;

  const log = getLogger();
  log.info({ retentionDays: env.DATA_RETENTION_DAYS }, 'Data retention enabled — scheduling daily purge');

  // Run once at startup, then every 24 h
  void runPurge();

  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => { void runPurge(); }, 24 * 60 * 60 * 1000);

  // Allow the process to exit even if the timer is still active
  _timer.unref();
}

export function stopRetentionScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
