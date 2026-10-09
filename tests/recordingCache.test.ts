import { describe, it, expect, vi, beforeAll } from 'vitest';

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

describe('recordingCache', () => {
  it('prefetch stores the mp3 so the proxy can serve it without a second Twilio fetch', async () => {
    const { loadEnv } = await import('../src/config/env');
    loadEnv();
    const { prefetchRecording, getCachedRecording } = await import('../src/services/recordingCache');

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.twilio.com/Recordings/RE123.mp3');
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(getCachedRecording('log-1')).toBeUndefined();
    await prefetchRecording('log-1', 'https://api.twilio.com/Recordings/RE123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.from(getCachedRecording('log-1')!)).toEqual([1, 2, 3]);

    vi.unstubAllGlobals();
  });

  it('prefetch rejects (and caches nothing) when Twilio answers non-2xx', async () => {
    const { prefetchRecording, getCachedRecording } = await import('../src/services/recordingCache');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    await expect(prefetchRecording('log-2', 'https://api.twilio.com/Recordings/RE404')).rejects.toThrow('HTTP 404');
    expect(getCachedRecording('log-2')).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
