import { Router, Request, Response } from 'express';
import { getActiveSessionCount } from '../services/callOrchestrator';
import { getHealthStats } from '../services/healthAlert';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const stats = getHealthStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeCalls: getActiveSessionCount(),
    uptime: Math.round(process.uptime()),
    errors: stats,
  });
});

export default router;
