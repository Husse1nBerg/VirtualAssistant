import { Router, Request, Response } from 'express';
import { getActiveSessionCount } from '../services/callOrchestrator';
import { getHealthStats } from '../services/healthAlert';
import { getEnv } from '../config';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const stats = getHealthStats();
  const env = getEnv();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeCalls: getActiveSessionCount(),
    uptime: Math.round(process.uptime()),
    errors: stats,
    // Which voice provider this instance actually booted with — settles "did the env
    // var take?" without reading Render logs. No secrets: key presence only.
    tts: { provider: env.TTS_PROVIDER, elevenLabsKeySet: env.ELEVENLABS_API_KEY.length > 0 },
    // Daily agenda: which pieces are configured (presence only, never the links or keys).
    agenda: {
      enabled: env.AGENDA_ENABLED,
      hour: env.AGENDA_HOUR,
      timezone: env.AGENDA_TIMEZONE,
      workCalendar: env.WORK_CALENDAR_ICS_URL.length > 0,
      googleCalendar: env.GOOGLE_CALENDAR_ICS_URL.length > 0,
      grokKeySet: env.XAI_API_KEY.length > 0,
    },
  });
});

export default router;
