import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { handleAgentEvent } from '../src/services/callOrchestrator';

describe('barge-in', () => {
  it('flushes Twilio playback when the caller starts speaking', () => {
    const send = vi.fn();
    const session = { callId: 'c1', streamSid: 'MZ123', twilioWs: { readyState: WebSocket.OPEN, send } } as any;

    handleAgentEvent(session, { type: 'UserStartedSpeaking' });

    expect(send).toHaveBeenCalledWith(JSON.stringify({ event: 'clear', streamSid: 'MZ123' }));
  });
});
