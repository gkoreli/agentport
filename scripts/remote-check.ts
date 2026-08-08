/** Pair + prompt against a *deployed* relay. Nothing local but the agent. */
import { WebSocket as NodeWebSocket } from 'ws';
import { AgentDaemon } from '../packages/daemon/src/daemon.js';
import { DemoWriterRuntime } from '../packages/daemon/src/runtime.js';
import { AgentWallet, type SiteTool } from '../packages/client/src/index.js';
import { Deferred, generateKeyPair } from '../packages/protocol/src/index.js';

const relayUrl = process.env.AGENTPORT_RELAY ?? 'wss://agentport.gogakoreli.workers.dev/relay';
const socketFactory = (url: string) => new NodeWebSocket(url) as never;
const doc = { text: 'Hosted relay test.' };
const tools: SiteTool[] = [
  { name: 'inkwell.document.read', description: 'Read the document', inputSchema: { type: 'object', properties: {} }, handler: () => ({ text: doc.text }) },
  { name: 'inkwell.document.replaceSelection', description: 'Replace the document', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, requiresApproval: true, handler: (a) => { doc.text = String(a.text ?? ''); return { ok: true }; } },
];

const user = generateKeyPair();
const agentKeys = generateKeyPair();
const code = new Deferred<string>();

const daemon = new AgentDaemon({
  relayUrl,
  identity: { ...agentKeys, name: 'Remote Check Agent', runtime: 'demo-writer', location: 'laptop' },
  createRuntime: () => new DemoWriterRuntime(),
  onPairingCode: (c) => code.resolve(c),
});
console.log(`connecting to ${relayUrl}`);
// A deployed relay can legitimately refuse us — most often because it is on a
// different wire version, which is exactly what a lockstep protocol is
// supposed to do. That is a RESULT, not a crash, so it exits with the reason
// rather than a stack trace through `ws` internals. This is a command the
// README tells people to run, so what it prints on the common failure is part
// of the front door.
const started = await daemon.start().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}`);
  console.error('  The deployed relay and this checkout must be on the same wire version.');
  console.error('  Deploy the relay from this commit, or check out the one it is running.\n');
  process.exit(1);
});
console.log('daemon start:', started);

const wallet = new AgentWallet({ relayUrl, userSecretKey: user.secretKey, socketFactory });
await wallet.connect();
const offer = await wallet.claimPairing(await code.promise);
console.log('offer:', offer.agent.name);
await wallet.approvePairing(offer);
console.log('agents:', await wallet.listAgents());

const session = await wallet.openSession({
  agent: agentKeys.publicKey,
  surface: { name: 'Inkwell', origin: 'https://agentport.gogakoreli.workers.dev' },
  tools,
  decide: async () => true,
});
const reply = await session.prompt('Say hello from the edge.');
console.log('reply:', reply);
console.log('doc:', doc.text);
const ok = doc.text.includes('Say hello from the edge.');
console.log(ok ? 'REMOTE PASS' : 'REMOTE FAIL');
session.close(); wallet.close(); await daemon.stop();
process.exit(ok ? 0 : 1);
