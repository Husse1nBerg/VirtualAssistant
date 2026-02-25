import { PrismaClient } from '@prisma/client';
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
