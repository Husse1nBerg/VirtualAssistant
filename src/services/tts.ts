import { getEnv } from '../config';
import { getLogger } from '../utils/logger';

/**
 * Text-to-Speech service.
 * Converts text responses to mulaw audio for Twilio Media Streams.
 * Supports Deepgram TTS (default) and ElevenLabs as alternative.
 */
export class TTSService {
  private callId: string;
  private _latencyMs: number = 0;

  constructor(callId: string) {
    this.callId = callId;
  }

  get latencyMs(): number {
    return this._latencyMs;
  }

  /**
   * Synthesize text to mulaw 8kHz audio suitable for Twilio.
   * Returns base64-encoded audio chunks.
   */
  async synthesize(text: string): Promise<Buffer> {
    const env = getEnv();
    const log = getLogger();
    const start = Date.now();

    try {
      let audioBuffer: Buffer;

      if (env.TTS_PROVIDER === 'elevenlabs' && env.ELEVENLABS_API_KEY) {
        audioBuffer = await this.synthesizeElevenLabs(text);
      } else {
        audioBuffer = await this.synthesizeDeepgram(text);
      }

      this._latencyMs = Date.now() - start;
      log.info({ callId: this.callId, latencyMs: this._latencyMs, textLen: text.length }, 'TTS synthesized');
      return audioBuffer;
    } catch (err) {
      this._latencyMs = Date.now() - start;
      log.error({ callId: this.callId, err }, 'TTS synthesis error');
      throw err;
    }
  }

  private async synthesizeDeepgram(text: string): Promise<Buffer> {
    const env = getEnv();

    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(`Deepgram TTS error: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async synthesizeElevenLabs(text: string): Promise<Buffer> {
    const env = getEnv();

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS error: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
