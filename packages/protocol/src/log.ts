/** Browser-safe structured logging shared by every AgentPort runtime. */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  at: number;
  level: LogLevel;
  component: string;
  message: string;
  sessionId?: string;
  err?: { name: string; message: string; stack?: string };
  data?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

export interface LogContext {
  sessionId?: string;
  err?: unknown;
  data?: Record<string, unknown>;
}

export interface Logger {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  child(subcomponent: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bufferSize?: number;
}

/** pino-compatible ordering: larger numbers are more severe. */
const LEVEL_NUMBER: Record<LogLevel, number> = {
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
};

const DEFAULT_BUFFER_SIZE = 200;
let ringCapacity = DEFAULT_BUFFER_SIZE;
const ring: LogEntry[] = [];

/** Structural probes keep protocol browser-safe: no `node:*` or Node globals. */
const host = globalThis as unknown as {
  process?: { env?: Record<string, string | undefined>; versions?: { node?: string } };
  localStorage?: { getItem(key: string): string | null };
  console?: Partial<Record<LogLevel, (...args: unknown[]) => void>> & { log?: (...args: unknown[]) => void };
};

function isLevel(value: unknown): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug';
}

function configuredLevel(explicit: LogLevel | undefined): LogLevel {
  if (explicit) return explicit;
  const fromEnv = host.process?.env?.AGENTPORT_LOG?.toLowerCase();
  if (isLevel(fromEnv)) return fromEnv;
  try {
    const fromStorage = host.localStorage?.getItem('agentport.log')?.toLowerCase();
    if (isLevel(fromStorage)) return fromStorage;
  } catch {
    // Storage access is optional diagnostic configuration; denial is safe and
    // the documented default level remains available.
  }
  return 'info';
}

function safeText(value: unknown, fallback: string): string {
  try {
    return String(value);
  } catch {
    // Hostile throwables may define a throwing toString; the fallback is the
    // only representation that cannot obscure the original failure further.
    return fallback;
  }
}

function readString(value: object, key: 'name' | 'message' | 'stack'): string | undefined {
  try {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' && field.length > 0 ? field : undefined;
  } catch {
    // A thrown object may expose accessor properties that throw. Ignoring one
    // unsafe field is safe because toErr still returns a normalized failure.
    return undefined;
  }
}

/** Normalize any JavaScript throwable without assuming it is an Error. */
export function toErr(err: unknown): NonNullable<LogEntry['err']> {
  if (err !== null && (typeof err === 'object' || typeof err === 'function')) {
    const value = err as object;
    const name = readString(value, 'name') ?? 'NonError';
    const message = readString(value, 'message') ?? safeText(err, 'unprintable thrown value');
    const stack = readString(value, 'stack');
    return { name, message, ...(stack ? { stack } : {}) };
  }
  return { name: 'NonError', message: safeText(err, 'unprintable thrown value') };
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.replace(/[\r\n]+/g, ' '));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? safeText(value, '[unprintable]');
  } catch {
    return safeText(value, '[unprintable]');
  }
}

function lineFor(entry: LogEntry): string {
  const fields: string[] = [];
  if (entry.sessionId) fields.push(`sessionId=${displayValue(entry.sessionId)}`);
  if (entry.err) fields.push(`err=${displayValue(`${entry.err.name}: ${entry.err.message}`)}`);
  if (entry.data) {
    for (const [key, value] of Object.entries(entry.data).sort(([a], [b]) => a.localeCompare(b))) {
      fields.push(`${key}=${displayValue(value)}`);
    }
  }
  const message = entry.message.replace(/[\r\n]+/g, ' ');
  return `[${entry.component}] ${entry.level} ${message}${fields.length ? ` ${fields.join(' ')}` : ''}`;
}

const consoleSink: LogSink = (entry) => {
  const method = host.console?.[entry.level] ?? host.console?.log;
  if (!method) return;
  const line = lineFor(entry);
  if (host.process?.versions?.node) method.call(host.console, line);
  else method.call(host.console, line, entry);
};

function remember(entry: LogEntry): void {
  ring.push({
    ...entry,
    ...(entry.err ? { err: { ...entry.err } } : {}),
    ...(entry.data ? { data: { ...entry.data } } : {}),
  });
  if (ring.length > ringCapacity) ring.splice(0, ring.length - ringCapacity);
}

/** Return a snapshot, optionally restricted to this severity and above. */
export function recentLogs(level?: LogLevel): LogEntry[] {
  const minimum = level ? LEVEL_NUMBER[level] : Number.NEGATIVE_INFINITY;
  return ring
    .filter((entry) => LEVEL_NUMBER[entry.level] >= minimum)
    .map((entry) => ({
      ...entry,
      ...(entry.err ? { err: { ...entry.err } } : {}),
      ...(entry.data ? { data: { ...entry.data } } : {}),
    }));
}

interface LoggerState {
  level: LogLevel;
  sink: LogSink;
}

function makeLogger(component: string, state: LoggerState): Logger {
  const write = (level: LogLevel, message: string, context: LogContext = {}): void => {
    if (LEVEL_NUMBER[level] < LEVEL_NUMBER[state.level]) return;
    const entry: LogEntry = {
      at: Date.now(),
      level,
      component,
      message,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.err !== undefined ? { err: toErr(context.err) } : {}),
      ...(context.data ? { data: { ...context.data } } : {}),
    };
    remember(entry);
    try {
      state.sink(entry);
    } catch (sinkError) {
      // Logging must not take down the subsystem it observes. This direct
      // console fallback cannot recurse through the failed sink.
      consoleSink({
        at: Date.now(),
        level: 'error',
        component: 'log',
        message: 'log sink failed',
        err: toErr(sinkError),
        data: { droppedComponent: component, droppedLevel: level },
      });
    }
  };

  return {
    error: (message, context) => write('error', message, context),
    warn: (message, context) => write('warn', message, context),
    info: (message, context) => write('info', message, context),
    debug: (message, context) => write('debug', message, context),
    child: (subcomponent) => makeLogger(`${component}.${subcomponent}`, state),
  };
}

export function createLogger(component: string, options: LoggerOptions = {}): Logger {
  if (options.bufferSize !== undefined) {
    ringCapacity = Number.isFinite(options.bufferSize)
      ? Math.max(1, Math.floor(options.bufferSize))
      : DEFAULT_BUFFER_SIZE;
    if (ring.length > ringCapacity) ring.splice(0, ring.length - ringCapacity);
  }
  return makeLogger(component, {
    level: configuredLevel(options.level),
    sink: options.sink ?? consoleSink,
  });
}
