import { homedir } from 'node:os';
import { join } from 'node:path';
import { Relay } from './relay.js';

const port = Number(process.env.AGENTPORT_RELAY_PORT ?? 8787);
const host = process.env.AGENTPORT_RELAY_HOST ?? '127.0.0.1';
const storePath = process.env.AGENTPORT_RELAY_STORE ?? join(homedir(), '.agentport', 'relay-certs.json');

const relay = new Relay({ port, host, storePath, log: (m) => console.log(`[relay] ${m}`) });
await relay.listening();
console.log(`[relay] listening on ws://${host}:${relay.port}`);
console.log(`[relay] cert store: ${storePath}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
