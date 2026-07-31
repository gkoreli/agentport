/**
 * The drop-in path, against a real relay: a keyless "page" publishes a connect
 * request and prints the code, exactly as connect.js would. Pair with
 * `npm run connect <CODE>` in another terminal to exercise the whole thing.
 */
import { WebSocket as NodeWebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
import { AgentWallet, type SiteTool } from '../packages/client/src/index.js';
import { generateKeyPair } from '../packages/protocol/src/index.js';

const relayUrl = process.env.AGENTPORT_RELAY ?? 'wss://agentport.gogakoreli.workers.dev/relay';
const doc = { text: 'Widget test.' };

const tools: SiteTool[] = [
  {
    name: 'inkwell.document.read',
    description: 'Read the current document',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ text: doc.text }),
  },
  {
    name: 'inkwell.document.replaceSelection',
    description: 'Replace the document text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    requiresApproval: true,
    handler: (args) => {
      doc.text = String(args.text ?? '');
      return { ok: true };
    },
  },
];

const wallet = new AgentWallet({
  relayUrl,
  userSecretKey: generateKeyPair().secretKey,
  socketFactory: (url) => new NodeWebSocket(url) as never,
});
await wallet.connect();

const { code, accepted } = await wallet.beginConnect({
  surface: { name: 'Inkwell', origin: 'https://agentport.gogakoreli.workers.dev' },
  tools,
  decide: () => true,
});
if (process.env.AGENTPORT_CODE_FILE) writeFileSync(process.env.AGENTPORT_CODE_FILE, code);
console.log(`\n  run:  npm run connect ${code}\n`);

const session = await accepted;
console.log(`connected to ${session.info.agentName} (${session.info.runtime})`);
const reply = await session.prompt('verified');
console.log(`reply: ${reply.slice(0, 140)}`);
console.log(`doc: ${JSON.stringify(doc.text)}`);
const ok = doc.text.includes('verified');
console.log(ok ? 'CONNECT PASS' : 'CONNECT FAIL');
process.exit(ok ? 0 : 1);
