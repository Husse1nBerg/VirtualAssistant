import { createClient, LiveTranscriptionEvents, LiveClient } from '@deepgram/sdk';
import { EventEmitter } from 'events';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';

export interface STTEvents {
  transcript: (text: string, isFinal: boolean) => void;
  utterance: (text: string) => void;
  error: (err: Error) => void;
  close: () => void;
}

/**
 * Real-time Speech-to-Text using Deepgram's WebSocket API.
 * Receives raw mulaw audio from Twilio Media Streams and emits transcript events.
 */
export class DeepgramSTT extends EventEmitter {
  private connection: LiveClient | null = null;
  private callId: string;
  private currentUtterance: string = '';
  private silenceTimer: NodeJS.Timeout | null = null;
  private _latencyMs: number = 0;
  private _lastAudioTime: number = 0;

  constructor(callId: string) {
    super();
    this.callId = callId;
  }

  get latencyMs(): number {
    return this._latencyMs;
  }

  async start(): Promise<void> {
    const log = getLogger();
    const env = getEnv();

    const deepgram = createClient(env.DEEPGRAM_API_KEY);

    this.connection = deepgram.listen.live({
      model: 'nova-2',
      language: 'en-US',
      smart_format: true,
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      punctuate: true,
      interim_results: true,
      utterance_end_ms: 1200, // 1.2s silence = utterance boundary
      vad_events: true,
      endpointing: 300,
    });

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      log.info({ callId: this.callId }, 'Deepgram STT connection opened');
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      const isFinal = data.is_final === true;

      if (!transcript) return;

      // Track latency
      if (this._lastAudioTime > 0) {
        this._latencyMs = Date.now() - this._lastAudioTime;
      }

      this.emit('transcript', transcript, isFinal);

      if (isFinal) {
        this.currentUtterance += (this.currentUtterance ? ' ' : '') + transcript;
      }
    });

    this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (this.currentUtterance.trim()) {
        log.debug({ callId: this.callId, text: this.currentUtterance }, 'Utterance complete');
        this.emit('utterance', this.currentUtterance.trim());
        this.currentUtterance = '';
      }
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      log.error({ callId: this.callId, err }, 'Deepgram STT error');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      log.info({ callId: this.callId }, 'Deepgram STT connection closed');
      this.emit('close');
    });
  }

  /** Send raw mulaw audio buffer from Twilio */
  sendAudio(audioBuffer: Buffer): void {
    this._lastAudioTime = Date.now();
    if (this.connection) {
      this.connection.send(new Uint8Array(audioBuffer) as any);
    }
  }

  /** Flush any pending utterance */
  flush(): string {
    const pending = this.currentUtterance.trim();
    this.currentUtterance = '';
    return pending;
  }

  async close(): Promise<void> {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    if (this.connection) {
      this.connection.requestClose();
      this.connection = null;
    }
  }
}
