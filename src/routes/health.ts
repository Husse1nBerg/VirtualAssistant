import { Router, Request, Response } from 'express';
import { getActiveSessionCount } from '../services/callOrchestrator';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeCalls: getActiveSessionCount(),
    uptime: process.uptime(),
  });
});

export default router;
