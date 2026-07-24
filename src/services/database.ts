import { PrismaClient, type Contact } from '@prisma/client';
export type { Contact };
import { getLogger } from '../utils/logger';

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return _prisma;
}

export async function disconnectDb(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
    getLogger().info('Database disconnected');
  }
}

// ── Call Log Operations ──────────────────────────────

export interface CreateCallLogInput {
  twilioCallSid: string;
  fromNumber: string;
  toNumber: string;
}

export async function createCallLog(input: CreateCallLogInput) {
  return getPrisma().callLog.create({ data: input });
}

export async function updateCallLog(id: string, data: Record<string, unknown>) {
  return getPrisma().callLog.update({ where: { id }, data });
}

export async function getCallLogBySid(twilioCallSid: string) {
  return getPrisma().callLog.findUnique({ where: { twilioCallSid } });
}

/**
 * Atomically claim the right to send the post-call summary SMS.
 * Returns true only for the first caller (sets summarySentAt only when still null),
 * so the endCall path and the /voice/status fallback can't both text the owner.
 */
export async function markSummarySent(id: string): Promise<boolean> {
  const result = await getPrisma().callLog.updateMany({
    where: { id, summarySentAt: null },
    data: { summarySentAt: new Date() },
  });
  return result.count === 1;
}

export async function getCallLogById(id: string) {
  return getPrisma().callLog.findUnique({
    where: { id },
    include: { transcripts: true, notifications: true },
  });
}

// ── Transcript Operations ────────────────────────────

export async function addTranscript(callLogId: string, role: string, content: string) {
  return getPrisma().transcript.create({
    data: { callLogId, role, content },
  });
}

export async function getTranscripts(callLogId: string) {
  return getPrisma().transcript.findMany({
    where: { callLogId },
    orderBy: { timestamp: 'asc' },
  });
}

// ── Notification Operations ──────────────────────────

export interface CreateNotificationInput {
  callLogId: string;
  channel: 'sms' | 'whatsapp';
  recipient: string;
  status: 'sent' | 'failed' | 'pending';
  messageId?: string;
  error?: string;
  sentAt?: Date;
}

export async function createNotification(input: CreateNotificationInput) {
  return getPrisma().notificationLog.create({ data: input });
}

// ── Contact Operations ───────────────────────────────

/** Normalize to E.164 for consistent matching. Adds the North American country
 *  code so a bare 10-digit number (e.g. 514-839-3917) becomes +15148393917,
 *  matching Twilio's inbound `From`. Non-NANP numbers must already carry a `+`. */
function normalizePhone(raw: string): string {
  // Strip spaces, dashes, parentheses, dots
  const stripped = raw.replace(/[\s\-().]/g, '');
  if (stripped.startsWith('+')) return stripped;
  const digits = stripped.replace(/\D/g, '');
  // NANP: 10 digits → prepend +1; 11 digits starting with 1 → prepend +
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export async function getContactByPhone(phoneNumber: string): Promise<Contact | null> {
  const normalized = normalizePhone(phoneNumber);
  // Try exact match first, then normalized form
  return (
    (await getPrisma().contact.findUnique({ where: { phoneNumber } })) ??
    (normalized !== phoneNumber
      ? getPrisma().contact.findUnique({ where: { phoneNumber: normalized } })
      : null)
  );
}

export async function upsertContact(input: {
  phoneNumber: string;
  name: string;
  isVip?: boolean;
  alwaysUrgent?: boolean;
  notes?: string;
  language?: string;
}): Promise<Contact> {
  const phoneNumber = normalizePhone(input.phoneNumber);
  const fields = {
    name: input.name,
    isVip: input.isVip ?? false,
    alwaysUrgent: input.alwaysUrgent ?? false,
    notes: input.notes ?? null,
    language: input.language ?? 'en',
  };
  return getPrisma().contact.upsert({
    where: { phoneNumber },
    update: fields,
    create: { phoneNumber, ...fields },
  });
}

export async function deleteContact(id: string): Promise<void> {
  await getPrisma().contact.delete({ where: { id } });
}

export async function getAllContacts(): Promise<Contact[]> {
  return getPrisma().contact.findMany({ orderBy: { name: 'asc' } });
}

/**
 * Resolve a contact by name or phone. Use for voice commands like "text John ...".
 * If identifier looks like a phone number (E.164-ish), look up by phone; otherwise search by name (case-insensitive).
 */
export async function getContactByNameOrPhone(identifier: string): Promise<Contact | null> {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length >= 10) {
    const withPlus = trimmed.startsWith('+') ? trimmed : `+${digitsOnly}`;
    return getContactByPhone(withPlus);
  }
  const all = await getPrisma().contact.findMany({ orderBy: { name: 'asc' } });
  const lower = trimmed.toLowerCase();
  const exact = all.find((c) => c.name.toLowerCase() === lower);
  if (exact) return exact;
  const contains = all.find((c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()));
  return contains ?? null;
}

export async function getRecentCallsByNumber(phoneNumber: string, limit = 5) {
  return getPrisma().callLog.findMany({
    where: { fromNumber: phoneNumber },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: { id: true, reasonForCall: true, startedAt: true },
  });
}

export async function getRecentCalls(limit: number) {
  return getPrisma().callLog.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { transcripts: true },
  });
}

export async function searchCalls(query: string, limit = 50) {
  const q = query.trim();
  if (!q) return getRecentCalls(limit);
  return getPrisma().callLog.findMany({
    where: {
      OR: [
        { callerName: { contains: q } },
        { company: { contains: q } },
        { reasonForCall: { contains: q } },
        { summary: { contains: q } },
        { fromNumber: { contains: q } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { transcripts: true },
  });
}

export interface CallAnalytics {
  totalCalls: number;
  avgDurationSeconds: number | null;
  urgencyDistribution: { urgency: string; count: number }[];
  topCallers: { fromNumber: string; callerName: string | null; count: number }[];
  callsLast7Days: number;
  callsLast30Days: number;
}

export async function getCallAnalytics(): Promise<CallAnalytics> {
  const prisma = getPrisma();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalCalls,
    callsLast7Days,
    callsLast30Days,
    urgencyRaw,
    durationRaw,
  ] = await Promise.all([
    prisma.callLog.count(),
    prisma.callLog.count({ where: { startedAt: { gte: sevenDaysAgo } } }),
    prisma.callLog.count({ where: { startedAt: { gte: thirtyDaysAgo } } }),
    prisma.callLog.groupBy({
      by: ['urgency'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),
    prisma.callLog.aggregate({ _avg: { durationSeconds: true } }),
  ]);

  // Top callers: group by fromNumber, pick name from most recent call, take top 5
  const topCallersRaw = await prisma.callLog.groupBy({
    by: ['fromNumber'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 5,
  });

  const topCallers = await Promise.all(
    topCallersRaw.map(async (row) => {
      const recent = await prisma.callLog.findFirst({
        where: { fromNumber: row.fromNumber },
        orderBy: { startedAt: 'desc' },
        select: { callerName: true },
      });
      return {
        fromNumber: row.fromNumber,
        callerName: recent?.callerName ?? null,
        count: row._count.id,
      };
    })
  );

  const urgencyDistribution = urgencyRaw.map((r) => ({
    urgency: r.urgency ?? 'unknown',
    count: r._count.id,
  }));

  return {
    totalCalls,
    avgDurationSeconds: durationRaw._avg.durationSeconds ?? null,
    urgencyDistribution,
    topCallers,
    callsLast7Days,
    callsLast30Days,
  };
}

/**
 * Delete call logs (and cascaded transcripts + notifications) older than `days` days.
 * Returns the number of deleted records.
 */
export async function deleteOldCallLogs(days: number): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await getPrisma().callLog.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });
  return result.count;
}

/** Update notification log by Twilio message SID (for delivery status callbacks). */
export async function updateNotificationByMessageId(
  messageId: string,
  data: { status?: string; error?: string }
) {
  return getPrisma().notificationLog.updateMany({
    where: { messageId },
    data,
  });
}
