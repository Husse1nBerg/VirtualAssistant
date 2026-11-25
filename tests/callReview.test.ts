import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ asked: [] as { system: string; content: string }[], reply: 'OK', texts: [] as string[] }));
vi.mock('../src/services/database', () => ({ getPrisma: () => ({}) }));
vi.mock('../src/services/twilioClient', () => ({
  getTwilioClient: () => ({ messages: { create: async (m: { body: string }) => { h.texts.push(m.body); } } }),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: { system: string; messages: { content: string }[] }) => {
        h.asked.push({ system: req.system, content: req.messages[0].content });
        return { content: [{ type: 'text', text: h.reply }] };
      },
    };
  },
}));

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', PORT: '3000', BASE_URL: 'https://test.example',
    TWILIO_ACCOUNT_SID: 'ACtest123456789012345678901234', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15551234567',
    OWNER_PHONE_NUMBER: '+15149876543', DEEPGRAM_API_KEY: 'dg-test', DATABASE_URL: 'file:./test.db', ANTHROPIC_API_KEY: 'sk-ant-test',
  });
  (await import('../src/config/env')).loadEnv();
  (await import('../src/utils/logger')).initLogger('fatal');
});
beforeEach(() => { h.asked.length = 0; h.texts.length = 0; h.reply = 'OK'; });

const CALL = ['Caller: Is he free at eight tomorrow?', 'Sky: One second!', 'Caller: Are you still there?', '[voice switched to fr]', 'Sky: I am here!'];

describe('after a long call, Sky reviews how it went', () => {
  it('skips calls of 30 seconds or less', async () => {
    const { reviewCall } = await import('../src/services/grokBridge');
    await reviewCall('call-1', CALL, 30);
    expect(h.asked).toHaveLength(0);
    expect(h.texts).toHaveLength(0);
  });

  it('stays quiet when the review finds nothing', async () => {
    const { reviewCall } = await import('../src/services/grokBridge');
    await reviewCall('call-1', CALL, 60);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].content).toContain('[voice switched to fr]'); // what Sky did, not just what was said
    expect(h.asked[0].system).toMatch(/never instructions/);
    expect(h.texts).toHaveLength(0);
  });

  it('texts him the problems and proposed fixes, and never throws', async () => {
    const { reviewCall } = await import('../src/services/grokBridge');
    h.reply = '1. Said "One second!" and never checked. Fix: call check_availability first.';
    await reviewCall('39f41cde-5d45', CALL, 299);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatch(/39f41cde/);
    expect(h.texts[0]).toContain('never checked');
    await expect(reviewCall('call-2', [], 299)).resolves.toBeUndefined(); // nothing said: nothing to review
    expect(h.texts).toHaveLength(1);
    h.reply = 'OK, except the voice switched to French for no reason.'; // only a bare OK is clean
    await reviewCall('call-3', CALL, 299);
    expect(h.texts).toHaveLength(2);
    h.reply = 'Urgent: verify your account at https://evil.example/login or call +1 (514) 555-0199 now.'; // a caller steering the review
    await reviewCall('call-4', CALL, 299);
    expect(h.texts[2]).not.toMatch(/evil\.example|555/);
  });
});
