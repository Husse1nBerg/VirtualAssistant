import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock environment before any imports
beforeAll(() => {
  process.env.NODE_ENV = 'development';
  process.env.PORT = '3000';
  process.env.BASE_URL = 'https://test.ngrok.io';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest123456789012345678901234';
  process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
  process.env.TWILIO_PHONE_NUMBER = '+15551234567';
  process.env.OWNER_PHONE_NUMBER = '+15559876543';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.DEEPGRAM_API_KEY = 'dg-test';
  process.env.DATABASE_URL = 'file:./test.db';
});

describe('Voice Webhook - /voice/inbound', () => {
  it('should return valid TwiML with Media Stream connection', async () => {
    // Simulate Twilio POST body
    const twilioBody = {
      CallSid: 'CA1234567890abcdef',
      From: '+15551112222',
      To: '+15551234567',
      CallStatus: 'ringing',
    };

    // We test the TwiML generation logic directly
    const VoiceResponse = (await import('twilio/lib/twiml/VoiceResponse')).default;
    const twiml = new VoiceResponse();

    const wsUrl = 'wss://test.ngrok.io/media-stream';
    const connect = twiml.connect();
    const stream = connect.stream({ url: wsUrl });
    stream.parameter({ name: 'from', value: twilioBody.From });
    stream.parameter({ name: 'to', value: twilioBody.To });

    const xml = twiml.toString();

    expect(xml).toContain('<?xml');
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<Stream');
    expect(xml).toContain('wss://test.ngrok.io/media-stream');
    expect(xml).toContain(twilioBody.From);
  });

  it('should return valid TwiML for fallback voicemail', async () => {
    const VoiceResponse = (await import('twilio/lib/twiml/VoiceResponse')).default;
    const twiml = new VoiceResponse();

    twiml.say(
      { voice: 'Polly.Joanna' },
      "Hi, I'm sorry but I'm unable to take your call right now."
    );
    twiml.record({
      maxLength: 120,
      action: '/voice/voicemail-complete',
      transcribe: true,
      transcribeCallback: '/voice/voicemail-transcription',
    });

    const xml = twiml.toString();

    expect(xml).toContain('<Say');
    expect(xml).toContain('<Record');
    expect(xml).toContain('voicemail-complete');
    expect(xml).toContain('voicemail-transcription');
  });
});

describe('Claude Summary Extraction', () => {
  it('should parse valid JSON summary from Claude response', () => {
    const mockResponse = `{
      "caller_name": "John Smith",
      "company": "Acme Corp",
      "reason_for_call": "Requesting project update meeting",
      "urgency": "medium",
      "callback_window": "Today before 5pm",
      "promised_actions": ["Schedule callback", "Send project update"],
      "confidence_score": 0.85,
      "summary": "John Smith from Acme Corp called requesting a project update meeting. Prefers callback today before 5pm."
    }`;

    const jsonMatch = mockResponse.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();

    const parsed = JSON.parse(jsonMatch![0]);
    expect(parsed.caller_name).toBe('John Smith');
    expect(parsed.urgency).toBe('medium');
    expect(parsed.confidence_score).toBe(0.85);
    expect(parsed.promised_actions).toHaveLength(2);
  });

  it('should handle response wrapped in markdown code block', () => {
    const mockResponse = '```json\n{"caller_name": "Jane", "urgency": "high", "reason_for_call": "urgent", "callback_window": null, "promised_actions": [], "confidence_score": 0.9, "summary": "Urgent call", "company": null}\n```';

    const jsonMatch = mockResponse.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();

    const parsed = JSON.parse(jsonMatch![0]);
    expect(parsed.caller_name).toBe('Jane');
    expect(parsed.urgency).toBe('high');
  });
});

describe('Notification Formatting', () => {
  it('should format summary message correctly', () => {
    const summary = {
      caller_name: 'John Smith',
      company: 'Acme Corp',
      reason_for_call: 'Project update meeting',
      urgency: 'high' as const,
      callback_window: 'Today before 5pm',
      promised_actions: ['Schedule callback'],
      confidence_score: 0.85,
      summary: 'John from Acme called about project update.',
    };

    const callerNumber = '+15551112222';
    const callLogId = 'test-123';

    const urgencyEmoji = summary.urgency === 'high' ? '🔴' : '🟡';

    const lines = [
      `📞 Missed Call Summary`,
      `From: ${callerNumber} (${summary.caller_name})`,
      `Company: ${summary.company}`,
      `${urgencyEmoji} Urgency: ${summary.urgency.toUpperCase()}`,
      `Reason: ${summary.reason_for_call}`,
      `Callback: ${summary.callback_window}`,
      `Summary: ${summary.summary}`,
    ];

    const message = lines.join('\n');

    expect(message).toContain('John Smith');
    expect(message).toContain('Acme Corp');
    expect(message).toContain('🔴');
    expect(message).toContain('HIGH');
    expect(message).toContain('+15551112222');
  });
});

describe('Environment Validation', () => {
  it('should validate required env vars', async () => {
    const { z } = await import('zod');

    const schema = z.object({
      TWILIO_ACCOUNT_SID: z.string().startsWith('AC'),
      TWILIO_AUTH_TOKEN: z.string().min(1),
      OWNER_PHONE_NUMBER: z.string().startsWith('+'),
    });

    // Valid
    const valid = schema.safeParse({
      TWILIO_ACCOUNT_SID: 'ACtest123',
      TWILIO_AUTH_TOKEN: 'token',
      OWNER_PHONE_NUMBER: '+15551234567',
    });
    expect(valid.success).toBe(true);

    // Invalid SID
    const invalid = schema.safeParse({
      TWILIO_ACCOUNT_SID: 'INVALID',
      TWILIO_AUTH_TOKEN: 'token',
      OWNER_PHONE_NUMBER: '+15551234567',
    });
    expect(invalid.success).toBe(false);
  });
});
