import { Relay } from './relay.js';
import { createLogger } from '@agentport/protocol';

const log = createLogger('relay.cli');

process.on('uncaughtException', (err) => {
  log.error('uncaught exception; terminating relay', { err });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection; terminating relay', { err });
  process.exit(1);
});

const port = Number(process.env.AGENTPORT_RELAY_PORT ?? 8787);
const host = process.env.AGENTPORT_RELAY_HOST ?? '127.0.0.1';

const relay = new Relay({ port, host });
await relay.listening();
log.info('listening; relay is stateless and stores nothing', { data: { url: `ws://${host}:${relay.port}` } });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('graceful relay shutdown failed', { err, data: { signal } });
        process.exit(1);
      },
    );
  });
}
