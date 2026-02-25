import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadEnv, getEnv } from './config';
import { initLogger, getLogger } from './utils/logger';
import { requestIdMiddleware } from './utils/requestId';
import voiceRoutes from './routes/voice';
import smsRoutes from './routes/sms';
import healthRoutes from './routes/health';
import dashboardRoutes from './routes/dashboard';
import { handleMediaStreamConnection } from './services/callOrchestrator';
import { getPrisma, disconnectDb } from './services/database';

// ── Bootstrap ────────────────────────────────────────

async function main() {
  // Load & validate environment
  const env = loadEnv();
  const log = initLogger(env.LOG_LEVEL);

  log.info({ env: env.NODE_ENV, port: env.PORT }, 'Starting Virtual Assistant');

  // Connect to database
  await getPrisma().$connect();
  log.info('Database connected');

  // ── Express App ──────────────────────────────────

  const app = express();

  // Parse URL-encoded bodies (Twilio webhooks)
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Request ID middleware
  app.use(requestIdMiddleware);

  // Request logging
  app.use((req, _res, next) => {
    log.info({ method: req.method, url: req.url, requestId: req.requestId }, 'Request');
    next();
  });

  // ── Routes ─────────────────────────────────────

  app.use('/health', healthRoutes);
  app.use('/voice', voiceRoutes);
  app.use('/sms', smsRoutes);
  app.use('/dashboard', dashboardRoutes);

  // ── HTTP + WebSocket Server ────────────────────

  const server = createServer(app);

  // WebSocket server for Twilio Media Streams
  const wss = new WebSocketServer({ server, path: '/media-stream' });

  wss.on('connection', (ws: WebSocket) => {
    log.info('New Media Stream WebSocket connection');
    handleMediaStreamConnection(ws);
  });

  wss.on('error', (err) => {
    log.error({ err }, 'WebSocket server error');
  });

  // ── Start Server ───────────────────────────────

  server.listen(env.PORT, () => {
    log.info(`Server listening on port ${env.PORT}`);
    log.info(`Health check: http://localhost:${env.PORT}/health`);
    log.info(`Voice webhook: ${env.BASE_URL}/voice/inbound`);
    log.info(`Media stream: ${env.BASE_URL.replace(/^http/, 'ws')}/media-stream`);
  });

  // ── Graceful Shutdown ──────────────────────────

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');

    // Close WebSocket connections
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    });

    // Close HTTP server
    server.close(() => {
      log.info('HTTP server closed');
    });

    // Disconnect DB
    await disconnectDb();

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
