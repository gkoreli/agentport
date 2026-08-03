import { createLogger, recentLogs, type LogEntry } from '@agentport/protocol';

export const siteLogger = createLogger('site');

type DebugSurface = {
  logs?: () => LogEntry[];
  observing?: boolean;
};

const host = window as Window & { __agentport?: unknown };
const existing = host.__agentport;
const debug: DebugSurface = typeof existing === 'object' && existing !== null ? existing : {};
host.__agentport = debug;
debug.logs = () => recentLogs();

if (!debug.observing) {
  debug.observing = true;
  window.addEventListener('error', (event) => {
    siteLogger.error('uncaught page error', {
      err: event.error ?? event.message,
      data: { filename: event.filename, line: event.lineno, column: event.colno },
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    siteLogger.error('unhandled page rejection', { err: event.reason });
  });
}
