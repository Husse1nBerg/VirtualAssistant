import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { handleAgentEvent, forwardAudioToTwilio } from '../src/services/callOrchestrator';

const makeSession = () => {
  const send = vi.fn();
  const session = { callId: 'c1', streamSid: 'MZ123', twilioWs: { readyState: WebSocket.OPEN, send } } as any;
  return { session, send };
};
const sentEvents = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([m]) => JSON.parse(m).event);

describe('barge-in', () => {
  it('flushes Twilio playback when the caller starts speaking', () => {
    const { session, send } = makeSession();
    handleAgentEvent(session, { type: 'UserStartedSpeaking' });
    expect(send).toHaveBeenCalledWith(JSON.stringify({ event: 'clear', streamSid: 'MZ123' }));
  });

  it('drops late audio from the cancelled reply until the next reply starts', () => {
    const { session, send } = makeSession();
    forwardAudioToTwilio(session, Buffer.from([1, 2]));      // reply playing
    handleAgentEvent(session, { type: 'UserStartedSpeaking' });
    forwardAudioToTwilio(session, Buffer.from([3, 4, 5]));   // straggler from cancelled reply
    handleAgentEvent(session, { type: 'AgentStartedSpeaking' });
    forwardAudioToTwilio(session, Buffer.from([6]));         // next reply

    expect(sentEvents(send)).toEqual(['media', 'clear', 'media']);
    expect(session.droppedAudioBytes).toBe(0); // reset once the next reply started
  });
});
