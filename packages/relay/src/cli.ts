import { Relay } from './relay.js';

const port = Number(process.env.AGENTPORT_RELAY_PORT ?? 8787);
const host = process.env.AGENTPORT_RELAY_HOST ?? '127.0.0.1';

const relay = new Relay({ port, host, log: (m) => console.log(`[relay] ${m}`) });
await relay.listening();
console.log(`[relay] listening on ws://${host}:${relay.port} — stateless; nothing is stored here`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
