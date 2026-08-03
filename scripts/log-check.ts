import { createLogger, recentLogs, toErr, type LogEntry } from '@agentport/protocol';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`logger check failed: ${message}`);
}

const captured: LogEntry[] = [];
const log = createLogger('check', {
  level: 'warn',
  bufferSize: 3,
  sink: (entry) => captured.push(entry),
});

log.debug('filtered debug');
log.info('filtered info');
log.warn('kept warning', { data: { attempt: 1 } });
log.error('kept error', { sessionId: 'sess_check', err: 'string failure' });

check(captured.length === 2, 'threshold filters debug and info');
check(captured[0]?.level === 'warn' && captured[1]?.level === 'error', 'levels retain severity');
check(captured[1]?.err?.name === 'NonError', 'non-Error throwables are normalized');
check(captured[1]?.err?.message === 'string failure', 'non-Error throwable content is retained');

const child = log.child('child');
child.error('child entry');
child.warn('ring rollover');
check(captured[2]?.component === 'check.child', 'child component is namespaced');

const recent = recentLogs();
check(recent.length === 3, 'ring buffer stays bounded');
check(recent[0]?.message === 'kept error', 'ring buffer evicts the oldest entry');
check(recentLogs('error').every((entry) => entry.level === 'error'), 'recentLogs filters by threshold');

const hostile = Object.create(null) as { toString?: () => string };
hostile.toString = () => {
  throw new Error('do not stringify me');
};
check(toErr(hostile).message === 'unprintable thrown value', 'hostile throwables normalize safely');
check(toErr(42).message === '42', 'primitive throwables normalize safely');

console.log('logger check: 10 checks passed');
