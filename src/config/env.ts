import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BASE_URL: z.string().url(),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC'),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().startsWith('+'),
  TWILIO_WHATSAPP_FROM: z.string().optional().default(''), // e.g. +14155238886 for sandbox; leave empty to use TWILIO_PHONE_NUMBER

  // Owner
  OWNER_PHONE_NUMBER: z.string().startsWith('+'),
  OWNER_WHATSAPP_NUMBER: z.string().optional().default(''),

  // LLM for voice agent: openai (Deepgram managed) or anthropic (requires key in Deepgram Console)
  USE_OPENAI_FOR_AGENT: z.coerce.boolean().default(true),

  // Anthropic (optional; used only when USE_OPENAI_FOR_AGENT is false)
  ANTHROPIC_API_KEY: z.string().optional().default(''),

  // Deepgram
  DEEPGRAM_API_KEY: z.string().min(1),

  // TTS
  TTS_PROVIDER: z.enum(['deepgram', 'elevenlabs']).default('deepgram'),
  ELEVENLABS_API_KEY: z.string().optional().default(''),
  ELEVENLABS_VOICE_ID: z.string().optional().default(''),

  // Database
  DATABASE_URL: z.string().default('file:./dev.db'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) throw new Error('Environment not loaded. Call loadEnv() first.');
  return _env;
}
