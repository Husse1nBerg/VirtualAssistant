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

export async function getContactByPhone(phoneNumber: string): Promise<Contact | null> {
  return getPrisma().contact.findUnique({ where: { phoneNumber } });
}

export async function upsertContact(input: {
  phoneNumber: string;
  name: string;
  isVip?: boolean;
  notes?: string;
}): Promise<Contact> {
  return getPrisma().contact.upsert({
    where: { phoneNumber: input.phoneNumber },
    update: { name: input.name, isVip: input.isVip ?? false, notes: input.notes ?? null },
    create: { phoneNumber: input.phoneNumber, name: input.name, isVip: input.isVip ?? false, notes: input.notes ?? null },
  });
}

export async function deleteContact(id: string): Promise<void> {
  await getPrisma().contact.delete({ where: { id } });
}

export async function getAllContacts(): Promise<Contact[]> {
  return getPrisma().contact.findMany({ orderBy: { name: 'asc' } });
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
