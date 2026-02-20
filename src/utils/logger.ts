import pino from 'pino';

let _logger: pino.Logger | null = null;

export function initLogger(level: string = 'info'): pino.Logger {
  _logger = pino({
    level,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
        : undefined,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) return initLogger();
  return _logger;
}
