import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { handleAgentEvent, forwardAudioToTwilio } from '../src/services/callOrchestrator';

describe('barge-in', () => {
  it('flushes Twilio playback when the caller starts speaking', () => {
    const send = vi.fn();
    const session = { callId: 'c1', streamSid: 'MZ123', twilioWs: { readyState: WebSocket.OPEN, send } } as any;

    handleAgentEvent(session, { type: 'UserStartedSpeaking' });

    expect(send).toHaveBeenCalledWith(JSON.stringify({ event: 'clear', streamSid: 'MZ123' }));
  });

  // Regression: the #9 audio gate muted every reply after the first interruption
  // (call CAcff767c7, Oct 20). No agent event may be required to hear Sky again.
  it('keeps Sky audible after the caller interrupts', () => {
    const send = vi.fn();
    const session = { callId: 'c1', streamSid: 'MZ123', twilioWs: { readyState: WebSocket.OPEN, send } } as any;

    handleAgentEvent(session, { type: 'UserStartedSpeaking' });
    forwardAudioToTwilio(session, Buffer.from([1, 2, 3]));

    expect(send).toHaveBeenLastCalledWith(
      JSON.stringify({ event: 'media', streamSid: 'MZ123', media: { payload: Buffer.from([1, 2, 3]).toString('base64') } })
    );
  });
});
