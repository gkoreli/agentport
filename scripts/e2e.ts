/**
 * End-to-end exercise of the whole loop:
 *
 *   pair -> discover -> grant -> prompt -> agent calls a site tool ->
 *   approval round-trip -> document mutated in the "browser"
 *
 * Runs relay + daemon + wallet in one process over real WebSockets.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Relay } from '../packages/relay/src/relay.js';
import { AgentDaemon } from '../packages/daemon/src/daemon.js';
import { McpBridge } from '../packages/daemon/src/mcp-bridge.js';
import { AcpRuntime } from '../packages/daemon/src/runtimes/acp.js';
import { DemoWriterRuntime, type AgentRuntime, type TurnContext } from '../packages/daemon/src/runtime.js';
import { AgentWallet, buildGrant, type SiteTool } from '../packages/client/src/index.js';
import {
  Deferred,
  PROTOCOL_VERSION,
  authChallengeMessage,
  canonicalJson,
  generateKeyPair,
  hashGrant,
  sign,
  signCert,
  signDelegation,
  type Hex,
  type LogEntry,
  type PlanStep,
} from '../packages/protocol/src/index.js';
import {
  decrypt,
  deriveSecureChannel,
  encrypt,
  generateEphemeralKeyPair,
} from '../packages/protocol/src/channel.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const socketFactory = (url: string) => new NodeWebSocket(url) as never;

// --- transport state in isolation ------------------------------------------

console.log('0. secure channel state');
{
  const initiatorKeys = generateEphemeralKeyPair();
  const responderKeys = generateEphemeralKeyPair();
  const initiator = deriveSecureChannel(
    initiatorKeys.secretKey,
    responderKeys.publicKey,
    'agentport-test-v1',
    'attachment-1',
    'initiator',
  );
  const responder = deriveSecureChannel(
    responderKeys.secretKey,
    initiatorKeys.publicKey,
    'agentport-test-v1',
    'attachment-1',
    'responder',
  );
  const bytes = new TextEncoder().encode('channel payload');
  const aad = new TextEncoder().encode('routing context');
  const ciphertext = encrypt(initiator.send, bytes, aad);
  const plaintext = decrypt(responder.receive, ciphertext, aad);
  check('opposite roles derive interoperable directional state', new TextDecoder().decode(plaintext) === 'channel payload');

  let replay = '';
  try {
    decrypt(responder.receive, ciphertext, aad);
  } catch (err) {
    replay = (err as Error).message;
  }
  check('the receive counter rejects replay exactly', replay.includes('nonce out of sequence'), replay);

  const freshResponder = deriveSecureChannel(
    responderKeys.secretKey,
    initiatorKeys.publicKey,
    'agentport-test-v1',
    'attachment-1',
    'responder',
  );
  let wrongContext = '';
  try {
    decrypt(freshResponder.receive, ciphertext, new TextEncoder().encode('different context'));
  } catch (err) {
    wrongContext = (err as Error).message;
  }
  check('associated-data mismatch fails authentication', wrongContext.length > 0, wrongContext);
}

console.log('\n0b. official MCP transport');
{
  const bridgeLogs: LogEntry[] = [];
  const bridge = new McpBridge({ sink: (entry) => bridgeLogs.push(entry) });
  await bridge.start();
  const cancelled = new Deferred<boolean>();
  const registration = bridge.register(
    'sdk-check',
    [
      { name: 'page.read', description: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'page.slow', description: 'slow', inputSchema: { type: 'object', properties: {} } },
    ],
    async (name, _args, signal) => {
      if (name === 'page.read') return { text: 'ok' };
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          cancelled.resolve(true);
          reject(new Error('cancelled'));
        }, { once: true });
      });
    },
  );
  const mcp = new McpClient({ name: 'agentport-e2e', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(registration.url), {
    requestInit: { headers: { Authorization: `Bearer ${registration.token}` } },
  });
  await mcp.connect(transport);
  const listed = await mcp.listTools();
  check('official SDK lists the temporary grant', listed.tools.map((tool) => tool.name).join(',') === 'page_read,page_slow');
  const read = await mcp.callTool({ name: 'page_read', arguments: {} });
  check('official SDK returns structured tool content', read.structuredContent?.['text'] === 'ok', read);
  await mcp.callTool({ name: 'page_slow', arguments: {} }, undefined, { timeout: 30 }).catch(() => {});
  const didCancel = await Promise.race([
    cancelled.promise,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  check('MCP timeout aborts the exact in-flight surface call', didCancel === true);
  // The invoker observes abort before its rejected promise returns through the
  // MCP request handler's catch block; one event-loop turn joins that causal
  // chain before inspecting the emitted terminal span.
  await new Promise<void>((resolve) => setImmediate(resolve));
  check('MCP logs completed tool spans without arguments', bridgeLogs.some((entry) =>
    entry.message === 'MCP tool call completed' && entry.data?.['tool'] === 'page.read'));
  check('MCP logs cancelled tool spans without arguments', bridgeLogs.some((entry) =>
    entry.message === 'MCP tool call cancelled' && entry.data?.['tool'] === 'page.slow'));
  await mcp.close();
  await bridge.stop();
}

console.log('\n0c. ACP attachment identity');
{
  const bridge = new McpBridge({ sink: () => {} });
  const entries: LogEntry[] = [];
  const fixture = new URL('./fixtures/acp-session-agent.ts', import.meta.url).pathname;
  const makeRuntime = () => new AcpRuntime({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    bridge,
    sink: (entry) => entries.push(entry),
  });
  const context = {
    surface: { name: 'Same Label', origin: 'https://same.test' },
    grant: { tools: [] },
    tools: [],
  };
  const first = makeRuntime();
  const second = makeRuntime();
  await first.openSession(context);
  await second.openSession(context);
  const ids = entries
    .filter((entry) => entry.message === 'ACP session ready')
    .map((entry) => entry.data?.['acpSessionId']);
  check('same-named new attachments receive distinct ACP sessions', ids.length === 2 && new Set(ids).size === 2, ids);
  check('new attachments never enter implicit ACP resume', !entries.some((entry) => entry.message === 'ACP session resumed'));
  await first.closeSession();
  await second.closeSession();
  await bridge.stop();
}

// --- the "browser" document the site owns -----------------------------------

const doc = { text: 'The sea was calm.' };

function inkwellTools(): SiteTool[] {
  return [
    {
      name: 'inkwell.document.read',
      description: 'Read the current document',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ text: doc.text }),
    },
    {
      name: 'inkwell.document.replaceSelection',
      description: "Replace the user's selected text",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      requiresApproval: true,
      handler: (args) => {
        doc.text = String(args.text ?? '');
        return { ok: true, length: doc.text.length };
      },
    },
  ];
}

// --- boot -------------------------------------------------------------------

const relay = new Relay({ port: 0, sink: () => {} });
await relay.listening();
const relayUrl = `ws://127.0.0.1:${relay.port}`;
console.log(`relay on ${relayUrl}\n`);

const user = generateKeyPair();
const agentKeys = generateKeyPair();

const pairingCode = new Deferred<string>();
let pairingSink = pairingCode;
const ownerLocalApprovals: string[] = [];
const daemon = new AgentDaemon({
  relayUrl,
  identity: {
    secretKey: agentKeys.secretKey,
    publicKey: agentKeys.publicKey,
    name: "Goga's Writing Agent",
    runtime: 'demo-writer',
    location: 'Personal VPS',
  },
  createRuntime: () => new DemoWriterRuntime(),
  onPairingCode: (code) => pairingSink.resolve(code),
  onLocalApproval: async (summary) => {
    ownerLocalApprovals.push(summary);
    return true;
  },
});

console.log('1. pairing');
const started = await daemon.start();
check('daemon starts unbound', started.bound === false, started);

const wallet = new AgentWallet({ relayUrl, userSecretKey: user.secretKey, socketFactory });
await wallet.connect();

const code = await pairingCode.promise;
check('agent minted a pairing code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);

const offer = await wallet.claimPairing(code);
check('wallet sees the agent announcement', offer.agent.name === "Goga's Writing Agent", offer.agent);

const cert = await wallet.approvePairing(offer);
check('cert binds agent to user', cert.user === user.publicKey && cert.agent === agentKeys.publicKey);

const renewedPairingCode = new Deferred<string>();
pairingSink = renewedPairingCode;
daemon.beginPairing();
const renewedOffer = await wallet.claimPairing(await renewedPairingCode.promise);
const renewedCert = await wallet.approvePairing(renewedOffer);
check('a running bound agent can mint a fresh pairing link', renewedCert.agent === agentKeys.publicKey);

console.log('\n2. discovery');
const agents = await wallet.listAgents();
check('agent appears in the picker', agents.length === 1 && agents[0]!.agent === agentKeys.publicKey);
check('agent shows as online', agents[0]?.online === true, agents[0]);

console.log('\n3. session + capability grant');
const approvals: string[] = [];
const session = await wallet.openSession({
  agent: agentKeys.publicKey,
  surface: { name: 'Inkwell', route: '/documents/doc_123', origin: 'https://inkwell.test' },
  tools: inkwellTools(),
  decide: async (prompt) => {
    approvals.push(prompt.call?.name ?? prompt.summary);
    return true;
  },
});
check('session opened', session.info.agentName === "Goga's Writing Agent", session.info);
check('grant carries exactly the site tools', session.grant.tools.length === 2);

const toolEvents: string[] = [];
session.on('tool', (event) => toolEvents.push(`${event.name}:${event.ok}`));

// Plans are snapshots: each one replaces the last, so the wire must carry the
// whole checklist every time and the statuses must actually advance.
const plans: PlanStep[][] = [];
session.on('plan', (event) => plans.push(event.steps));

console.log('\n4. prompt -> tool loop');
const reply = await session.prompt('Then the wind rose.');
check('agent read the document', toolEvents.includes('inkwell.document.read:true'), toolEvents);
check('write was approved', approvals.length > 0, approvals);
check('document was mutated in the page', doc.text.endsWith('Then the wind rose.'), doc.text);
check('agent streamed a reply', reply.includes('Done.'), reply);

// The plan crossed the sealed channel as its own frame type: the runtime
// reported it, the daemon framed it, the wallet decoded it. Without the
// AGENT_SEALABLE entry openSealed would have refused it outright.
check('the agent reported a plan', plans.length > 0, plans.length);
const firstPlan = plans[0] ?? [];
const lastPlan = plans[plans.length - 1] ?? [];
check('every snapshot carries the whole plan', plans.every((steps) => steps.length === firstPlan.length), plans.map((s) => s.length));
check('the plan starts with work to do', firstPlan.some((step) => step.status === 'active'), firstPlan);
check('the plan finishes done', lastPlan.length > 0 && lastPlan.every((step) => step.status === 'done'), lastPlan);
check(
  'plan steps keep their identity across snapshots',
  firstPlan.map((step) => step.text).join('|') === lastPlan.map((step) => step.text).join('|'),
  { first: firstPlan.map((s) => s.text), last: lastPlan.map((s) => s.text) },
);

console.log('\n5. refusal path');
doc.text = 'Untouched.';
const declining = await wallet.openSession({
  agent: agentKeys.publicKey,
  surface: { name: 'Inkwell', origin: 'https://inkwell.test' },
  tools: inkwellTools(),
  decide: async () => false,
});
await declining.prompt('Rewrite everything.');
check('declined approval leaves the document alone', doc.text === 'Untouched.', doc.text);
declining.close();

console.log('\n6. grant is a real boundary');
const readOnly = await wallet.openSession({
  agent: agentKeys.publicKey,
  surface: { name: 'Inkwell', origin: 'https://inkwell.test' },
  tools: inkwellTools().filter((tool) => tool.name === 'inkwell.document.read'),
  decide: async () => true,
});
const readOnlyReply = await readOnly.prompt('Rewrite everything.');
check('agent cannot write without the tool', doc.text === 'Untouched.', doc.text);
check('agent degrades gracefully', readOnlyReply.includes('suggestion'), readOnlyReply);
readOnly.close();

console.log('\n7. unowned agents are invisible');
const stranger = new AgentWallet({
  relayUrl,
  userSecretKey: generateKeyPair().secretKey,
  socketFactory,
});
await stranger.connect();
const strangerAgents = await stranger.listAgents();
check('a different user sees no agents', strangerAgents.length === 0, strangerAgents);

let denied = '';
await stranger
  .openSession({
    agent: agentKeys.publicKey as Hex,
    surface: { name: 'Evil', origin: 'https://evil.test' },
    tools: [],
    decide: async () => true,
  })
  .catch((err: Error) => {
    denied = err.message;
  });
check('relay refuses sessions to agents you do not own', denied.includes('not_your_agent'), denied);

console.log('\n8. drop-in connect (no wallet in the page)');
doc.text = 'Before.';
let offered: { surface: string; tools: number } | null = null;
const localApprovals: string[] = [];

const dropInAgentKeys = generateKeyPair();
const dropInDaemon = new AgentDaemon({
  relayUrl,
  identity: {
    secretKey: dropInAgentKeys.secretKey,
    publicKey: dropInAgentKeys.publicKey,
    name: 'Terminal Agent',
    runtime: 'demo-writer',
  },
  createRuntime: () => new DemoWriterRuntime(),
  // The consent moment lives here, with the key — not in the page.
  onConnectOffer: async (offer) => {
    offered = { surface: offer.surface.name, tools: offer.grant.tools.length };
    return true;
  },
  onLocalApproval: async (summary) => {
    localApprovals.push(summary);
    return true;
  },
});
await dropInDaemon.start();

// The "page": an ephemeral key with no certs at all.
const ephemeral = new AgentWallet({
  relayUrl,
  userSecretKey: generateKeyPair().secretKey,
  socketFactory,
});
await ephemeral.connect();

check('a keyless page sees no agents', (await ephemeral.listAgents()).length === 0);

const requested = await ephemeral.beginConnect({
  surface: { name: 'Inkwell', origin: 'https://inkwell.test' },
  tools: inkwellTools(),
  decide: () => true,
});
check('widget gets a connect code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(requested.code), requested.code);

dropInDaemon.claimConnect(requested.code);
const dropInSession = await requested.accepted;
const seenOffer = offered as { surface: string; tools: number } | null;
check('owner saw what was being asked for', seenOffer?.surface === 'Inkwell' && seenOffer?.tools === 2, seenOffer);
check('session opened without any cert', dropInSession.info.agentName === 'Terminal Agent', dropInSession.info);

await dropInSession.prompt('Add a line.');
check('gated write was approved by the owner, not the page', localApprovals.length > 0, localApprovals);
check('document changed', doc.text.endsWith('Add a line.'), doc.text);

// The important negative: the page still cannot reach that agent directly.
let directDenied = '';
await ephemeral
  .openSession({
    agent: dropInAgentKeys.publicKey,
    surface: { name: 'Inkwell', origin: 'https://inkwell.test' },
    tools: inkwellTools(),
    decide: () => true,
  })
  .catch((err: Error) => {
    directDenied = err.message;
  });
check('a connected page still cannot open its own session', directDenied.includes('not_your_agent'), directDenied);

dropInSession.close();
ephemeral.close();
await dropInDaemon.stop();

console.log('\n9. resume tokens are a real boundary');
const resumeAgentKeys = generateKeyPair();
const resumeDaemon = new AgentDaemon({
  relayUrl,
  identity: { ...resumeAgentKeys, name: 'Resume Agent', runtime: 'demo-writer' },
  createRuntime: () => new DemoWriterRuntime(),
  onConnectOffer: async () => true,
  onLocalApproval: async () => true,
});
await resumeDaemon.start();

const tab = new AgentWallet({ relayUrl, userSecretKey: generateKeyPair().secretKey, socketFactory });
await tab.connect();
const req = await tab.beginConnect({
  surface: { name: 'Inkwell', origin: 'https://inkwell.test' },
  tools: inkwellTools(),
  decide: () => true,
});
resumeDaemon.claimConnect(req.code);
const liveSession = await req.accepted;
const resumeToken = tab.resumeTokenFor(liveSession.id)!;
check('a resume token was issued', typeof resumeToken === 'string' && resumeToken.length >= 32);

// Say something, so there is a conversation worth restoring.
doc.text = 'Resume test.';
await liveSession.prompt('Add a line.');

// While the original tab is still attached, nobody else may take the session.
const thief = new AgentWallet({ relayUrl, userSecretKey: generateKeyPair().secretKey, socketFactory });
await thief.connect();
let hijack = '';
await thief
  .resumeSession({ id: liveSession.id, agent: resumeAgentKeys.publicKey, token: resumeToken, tools: inkwellTools(), decide: () => true })
  .catch((err: Error) => {
    hijack = err.message;
  });
check('a live session cannot be stolen even with the token', hijack.includes('already_attached'), hijack);

// Now the tab "refreshes" — the socket drops without ending the session.
tab.disconnect();
await new Promise((resolve) => setTimeout(resolve, 150));

let wrongToken = '';
await thief
  .resumeSession({ id: liveSession.id, agent: resumeAgentKeys.publicKey, token: 'f'.repeat(48), tools: inkwellTools(), decide: () => true })
  .catch((err: Error) => {
    wrongToken = err.message;
  });
check('a wrong token is refused', wrongToken.includes('not_resumable'), wrongToken);

let unknownSession = '';
await thief
  .resumeSession({ id: 'sess_does_not_exist', agent: resumeAgentKeys.publicKey, token: resumeToken, tools: inkwellTools(), decide: () => true })
  .catch((err: Error) => {
    unknownSession = err.message;
  });
check(
  'an unknown session is indistinguishable from a wrong token',
  unknownSession === wrongToken,
  { unknownSession, wrongToken },
);

// A resume answer is authority over someone else's session. An unrelated
// agent — authenticated, but not the one the resume was routed to — must not
// be able to answer one, even knowing the session id.
{
  const impostorKeys = generateKeyPair();
  const impostor = new NodeWebSocket(relayUrl);
  const impostorFrames: string[] = [];
  await new Promise((resolve) => impostor.on('open', resolve));
  impostor.on('message', (data) => impostorFrames.push(data.toString()));
  const answered = new Deferred<void>();
  impostor.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as { t: string; nonce?: string };
    if (frame.t === 'challenge') {
      impostor.send(canonicalJson({
        t: 'identify',
        pubkey: impostorKeys.publicKey,
        sig: sign(impostorKeys.secretKey, authChallengeMessage(frame.nonce!)),
        announce: { name: 'Impostor', runtime: 'demo-writer' },
      }));
    }
    if (frame.t === 'ready') answered.resolve();
  });
  impostor.send(canonicalJson({ t: 'hello', v: PROTOCOL_VERSION, role: 'agent' }));
  await answered.promise;

  // A resume is now in flight to Resume Agent. Its token is wrong, so the real
  // daemon will refuse it — which makes a forged ACCEPTANCE the sharp test: if
  // the relay let an unrelated agent answer, this doomed resume would succeed.
  const racer = new AgentWallet({ relayUrl, userSecretKey: generateKeyPair().secretKey, socketFactory });
  await racer.connect();
  const racing = racer.resumeSession({
    id: liveSession.id,
    agent: resumeAgentKeys.publicKey,
    token: 'e'.repeat(48),
    tools: inkwellTools(),
    decide: () => true,
  });
  impostor.send(canonicalJson({
    t: 'session.resumed',
    s: liveSession.id,
    agentName: 'Impostor',
    runtime: 'demo-writer',
    surface: { name: 'Inkwell', origin: 'https://inkwell.test' },
    grant: { tools: [], alwaysAsk: [], expiresAt: Date.now() + 60_000 },
    missed: 0,
    epk: 'a'.repeat(64),
    epkSig: 'b'.repeat(128),
  }));
  const outcome = await racing.then(() => 'resumed').catch((err: Error) => err.message);
  check(
    'an unrelated agent cannot answer a resume it was not routed',
    outcome.includes('not_resumable'),
    { outcome },
  );
  check(
    'the forged resume answer is refused at the relay',
    impostorFrames.some((raw) => raw.includes('"forbidden"')),
    impostorFrames.slice(-1),
  );
  impostor.close();
  racer.close();
}

// The legitimate tab comes back.
const reopened = new AgentWallet({ relayUrl, userSecretKey: generateKeyPair().secretKey, socketFactory });
await reopened.connect();
const { session: back } = await reopened.resumeSession({
  id: liveSession.id,
  agent: resumeAgentKeys.publicKey,
  token: resumeToken,
  tools: inkwellTools(),
  decide: () => true,
});
check('the real tab resumes', back.info.agentName === 'Resume Agent', back.info);

const restored = await back.history();
check('the conversation is restored after a refresh', restored.length > 0, restored.length);
check(
  'it came from the agent side, not from anything the page kept',
  restored.some((entry) => entry.role === 'user' && entry.text.includes('Add a line')),
  restored.slice(0, 4),
);

back.close();
thief.close();
reopened.close();
await resumeDaemon.stop();

// --- 10. the relay is blind: an on-path observer learns nothing --------------
// The adversary model made literal: a recording proxy sits between the wallet
// and the relay, seeing exactly what the relay (or anyone else on the path
// inside TLS termination) sees. Lifecycle metadata, including the grant's tool
// names, is intentionally visible and authenticated. Conversation text, tool
// invocations/results, and inner content-frame types must remain sealed.
console.log('\n10. the relay is blind (ADR-003)');
{
  const { WebSocketServer: TapServer } = await import('ws');
  const observed: string[] = [];
  let attack: 'none' | 'tamper-and-replay' | 'strip-client-proof' | 'strip-agent-proof' | 'rewrite-grant' = 'none';
  let attackedContent = false;
  const tap = new TapServer({ port: 0, host: '127.0.0.1' });
  tap.on('connection', (inbound) => {
    const upstream = new NodeWebSocket(relayUrl);
    const up: string[] = [];
    upstream.on('open', () => { for (const m of up.splice(0)) upstream.send(m); });
    inbound.on('message', (data) => {
      let message = data.toString();
      observed.push(message);
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (attack === 'strip-client-proof' && parsed.t === 'session.open') {
        delete parsed.epk;
        delete parsed.epkSig;
        message = JSON.stringify(parsed);
      }
      if (attack === 'rewrite-grant' && parsed.t === 'session.open') {
        const grant = parsed.grant as { expiresAt: number };
        grant.expiresAt += 60_000;
        message = JSON.stringify(parsed);
      }
      const send = (value: string) => {
        if (upstream.readyState === NodeWebSocket.OPEN) upstream.send(value);
        else up.push(value);
      };
      if (attack === 'tamper-and-replay' && !attackedContent && parsed.t === 'enc') {
        attackedContent = true;
        const ciphertext = String(parsed.c);
        const final = ciphertext.at(-1) === '0' ? '1' : '0';
        send(JSON.stringify({ ...parsed, c: `${ciphertext.slice(0, -1)}${final}` }));
        send(message);
        send(message);
        return;
      }
      send(message);
    });
    upstream.on('message', (data) => {
      let message = data.toString();
      observed.push(message);
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (attack === 'strip-agent-proof' && parsed.t === 'session.opened') {
        delete parsed.epk;
        delete parsed.epkSig;
        message = JSON.stringify(parsed);
      }
      inbound.send(message);
    });
    inbound.on('close', () => upstream.close());
    upstream.on('close', () => inbound.close());
  });
  await new Promise((resolve) => tap.on('listening', resolve));
  const tapUrl = `ws://127.0.0.1:${(tap.address() as { port: number }).port}`;

  const sealKeys = generateKeyPair();
  const sealPairing = new Deferred<string>();
  const sealLogs: string[] = [];
  const sealDaemon = new AgentDaemon({
    relayUrl,
    identity: { ...sealKeys, name: 'Sealed Agent', runtime: 'demo-writer' },
    createRuntime: () => new DemoWriterRuntime(),
    onPairingCode: (code) => sealPairing.resolve(code),
    sink: (entry) => sealLogs.push(`${entry.message}${entry.err ? ` ${entry.err.message}` : ''}`),
  });
  await sealDaemon.start();

  const sealUser = generateKeyPair();
  // The short handshake timeout is what converts the strip-agent-proof attack
  // below from a hang into a rejection the test can observe.
  const observedWallet = new AgentWallet({ relayUrl: tapUrl, userSecretKey: sealUser.secretKey, socketFactory, handshakeTimeoutMs: 1_500 });
  await observedWallet.connect();
  const offer = await observedWallet.claimPairing(await sealPairing.promise);
  await observedWallet.approvePairing(offer);

  const SECRET = 'the launch codes are 000000';
  const sealedSession = await observedWallet.openSession({
    agent: sealKeys.publicKey,
    surface: { name: 'Sealed Site' },
    tools: inkwellTools(),
    decide: () => true,
  });
  check('the sealed session has fingerprint words', /^(?:\w+-){5}\w+$/.test(sealedSession.info.verify ?? ''), sealedSession.info.verify);
  attack = 'tamper-and-replay';
  await sealedSession.prompt(SECRET);
  attack = 'none';

  const wire = observed.join('\n');
  check('conversation text never crossed the wire in the clear', !wire.includes('launch codes'));
  check('grant tool names are disclosed as lifecycle metadata', wire.includes('inkwell.document.replaceSelection'));
  check('tool invocations never crossed the wire in the clear', !observed.some((m) => m.includes('"t":"tool.call"')));
  check('content frame types are hidden', !observed.some((m) => /"t":"(delta|prompt|tool\.call|tool\.result|approval)/.test(m)));
  check('sealed frames did cross it', observed.filter((m) => m.includes('"t":"enc"')).length >= 4, observed.filter((m) => m.includes('"t":"enc"')).length);
  check('tampered ciphertext was rejected without desynchronising the channel', sealLogs.some((line) => line.includes('failed to open sealed frame')), sealLogs);
  check('a replayed authenticated frame was rejected', sealLogs.some((line) => line.includes('dropped out-of-sequence sealed frame')), sealLogs);

  sealedSession.close();

  attack = 'strip-agent-proof';
  let strippedAgentProof = '';
  await observedWallet.openSession({
    agent: sealKeys.publicKey,
    surface: { name: 'Downgrade Test' },
    tools: inkwellTools(),
    decide: () => true,
  }).catch((err: Error) => { strippedAgentProof = err.message; });
  // Strict decode rejects the mangled session.opened outright (missing epk),
  // so the wallet never sees an answer and the handshake deadline fires —
  // fail-closed either way, with no plaintext downgrade path left to take.
  check('omitting the agent sealing proof aborts instead of downgrading', strippedAgentProof.includes('handshake timed out'), strippedAgentProof);
  observedWallet.close();

  attack = 'strip-client-proof';
  const downgradeWallet = new AgentWallet({ relayUrl: tapUrl, userSecretKey: sealUser.secretKey, socketFactory });
  await downgradeWallet.connect();
  let strippedClientProof = '';
  await downgradeWallet.openSession({
    agent: sealKeys.publicKey,
    surface: { name: 'Downgrade Test' },
    tools: inkwellTools(),
    decide: () => true,
  }).catch((err: Error) => { strippedClientProof = err.message; });
  // The schema requires epk/epkSig on session.open, so the RELAY now rejects
  // the stripped frame at decode — the daemon's own sealing_required check
  // became unreachable dead code and was deleted with it.
  check('omitting the client sealing proof is rejected at the relay', strippedClientProof.includes('missing_key at session.open.epk'), strippedClientProof);
  downgradeWallet.close();

  attack = 'rewrite-grant';
  const integrityWallet = new AgentWallet({ relayUrl: tapUrl, userSecretKey: sealUser.secretKey, socketFactory });
  await integrityWallet.connect();
  let rewrittenGrant = '';
  await integrityWallet.openSession({
    agent: sealKeys.publicKey,
    surface: { name: 'Integrity Test' },
    tools: inkwellTools(),
    decide: () => true,
  }).catch((err: Error) => { rewrittenGrant = err.message; });
  check('rewriting clear lifecycle metadata invalidates the handshake', rewrittenGrant.includes('bad_epk_proof'), rewrittenGrant);
  integrityWallet.close();
  await sealDaemon.stop();
  tap.close();
}

// --- 11. a relay redeploy does not strand the daemon --------------------------
// Deploying the Worker kills the Durable Object and severs every socket. The
// daemon must notice and come back on its own — no human restarting npx.
console.log('\n11. relay restarts are survived');
{
  const { Relay: FreshRelay } = await import('../packages/relay/src/relay.js');
  const bounce = new FreshRelay({ port: 0, sink: () => {} });
  await bounce.listening();
  const bounceUrl = `ws://127.0.0.1:${bounce.port}`;
  const port = bounce.port;

  const keys = generateKeyPair();
  const reDaemon = new AgentDaemon({
    relayUrl: bounceUrl,
    identity: { ...keys, name: 'Comeback Agent', runtime: 'demo-writer' },
    createRuntime: () => new DemoWriterRuntime(),
  });
  await reDaemon.start();

  const cameBack = new Deferred<boolean>();
  reDaemon.on('ready', () => cameBack.resolve(true));

  // The "deploy": the relay process dies and a new one takes the same port.
  await bounce.close();
  const revived = new FreshRelay({ port, sink: () => {} });
  await revived.listening();

  const back = await Promise.race([
    cameBack.promise,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  check('the daemon redialed and re-authenticated by itself', back === true);

  await reDaemon.stop();
  await revived.close();
}

// --- 12. a live session survives a relay RESTART (ADR-016) --------------------
// The relay is stateless: killing it and starting a fresh one loses only
// sockets. The daemon redials and still holds the session, the client comes
// back with its token, and the conversation continues. This is the property
// no amount of relay-side storage could give as cleanly.
console.log('\n12. sessions outlive the relay itself');
{
  const { Relay: FreshRelay } = await import('../packages/relay/src/relay.js');
  const r1 = new FreshRelay({ port: 0, sink: () => {} });
  await r1.listening();
  const relayPort = r1.port;
  const url = `ws://127.0.0.1:${relayPort}`;

  const agentKeys = generateKeyPair();
  const survivorPairing = new Deferred<string>();
  const survivorDaemon = new AgentDaemon({
    relayUrl: url,
    identity: { ...agentKeys, name: 'Survivor Agent', runtime: 'demo-writer' },
    createRuntime: () => new DemoWriterRuntime(),
    onPairingCode: (code) => survivorPairing.resolve(code),
  });
  await survivorDaemon.start();

  const user = new AgentWallet({ relayUrl: url, userSecretKey: generateKeyPair().secretKey, socketFactory });
  await user.connect();
  const pairOffer = await user.claimPairing(await survivorPairing.promise);
  await user.approvePairing(pairOffer);

  const before = await user.openSession({
    agent: agentKeys.publicKey,
    surface: { name: 'Survivor Site' },
    tools: inkwellTools(),
    decide: () => true,
  });
  await before.prompt('Remember the word heliotrope.');
  const survivorToken = user.resumeTokenFor(before.id)!;
  check('the daemon minted a resume token', survivorToken.length > 0);

  // The "deploy": relay dies, a new stateless one takes the port.
  const daemonBack = new Deferred<boolean>();
  survivorDaemon.on('ready', () => daemonBack.resolve(true));
  await r1.close();
  const r2 = new FreshRelay({ port: relayPort, sink: () => {} });
  await r2.listening();
  await daemonBack.promise;

  const laterTab = new AgentWallet({ relayUrl: url, userSecretKey: generateKeyPair().secretKey, socketFactory });
  await laterTab.connect();
  const { session: after } = await laterTab.resumeSession({
    id: before.id,
    agent: agentKeys.publicKey,
    token: survivorToken,
    tools: inkwellTools(),
    decide: () => true,
  });
  check('the session resumed through a relay that never saw it', after.info.agentName === 'Survivor Agent');
  check('and it resumed SEALED', /^(?:\w+-){5}\w+$/.test(after.info.verify ?? ''), after.info.verify);
  const memory = await after.history();
  check(
    'the conversation survived both the refresh and the relay',
    memory.some((entry) => entry.text.includes('heliotrope')),
    memory.length,
  );

  after.close();
  user.close();
  laterTab.close();
  await survivorDaemon.stop();
  await r2.close();
}

// --- 12b. a live attachment survives its own socket dying ---------------------
// The refresh path proves a session survives a RELOAD. This proves it survives
// a network blip with no reload at all: a sleeping laptop, a wifi change, a
// relay bounce. The page keeps the handle it already had — a "transparent"
// reconnect that returned a different object would be transparent to nobody.
console.log('\n12b. a dropped socket reconnects itself');
{
  const { Relay: FreshRelay } = await import('../packages/relay/src/relay.js');
  const blip = new FreshRelay({ port: 0, sink: () => {} });
  await blip.listening();
  const blipUrl = `ws://127.0.0.1:${blip.port}`;

  const agentKeys = generateKeyPair();
  const blipPairing = new Deferred<string>();
  const blipDaemon = new AgentDaemon({
    relayUrl: blipUrl,
    identity: { ...agentKeys, name: 'Blip Agent', runtime: 'demo-writer' },
    createRuntime: () => new DemoWriterRuntime(),
    onPairingCode: (code) => blipPairing.resolve(code),
  });
  await blipDaemon.start();

  // Hand the wallet sockets we can kill from the outside, the way a network
  // does — not through any API the wallet could treat as intentional.
  const liveSockets: NodeWebSocket[] = [];
  const blipUser = new AgentWallet({
    relayUrl: blipUrl,
    userSecretKey: generateKeyPair().secretKey,
    socketFactory: (url) => {
      const socket = new NodeWebSocket(url);
      liveSockets.push(socket);
      return socket as never;
    },
  });
  await blipUser.connect();
  const blipOffer = await blipUser.claimPairing(await blipPairing.promise);
  await blipUser.approvePairing(blipOffer);

  const session = await blipUser.openSession({
    agent: agentKeys.publicKey,
    surface: { name: 'Blippy Site' },
    tools: inkwellTools(),
    decide: () => true,
  });
  await session.prompt('Remember the word cinnabar.');
  const firstVerify = session.info.verify;

  const reattached = new Deferred<{ verify?: string }>();
  session.on('reattached', (event) => reattached.resolve(event));
  const reconnected = new Deferred<{ sessions: number; missed: number }>();
  blipUser.on('reconnected', (event) => reconnected.resolve(event));

  // The blip: kill the socket underneath the wallet. No close(), no
  // disconnect() — the wallet is not told, it has to notice.
  liveSockets[liveSockets.length - 1]!.terminate();

  const restored = await Promise.race([
    reconnected.promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  check('the wallet redialed and restored the session by itself', restored?.sessions === 1, restored);
  await reattached.promise;

  check('the page still holds the same session object', blipUser.resumeTokenFor(session.id) !== undefined);
  check('the session is not closed', session.closed === false);
  // Fresh ephemeral keys per attachment (ADR-003), so the fingerprint words
  // MUST change — identical words after a rekey would mean we reused a key.
  check('the reattachment rekeyed', session.info.verify !== firstVerify, {
    before: firstVerify,
    after: session.info.verify,
  });
  check('and it is still sealed', /^(?:\w+-){5}\w+$/.test(session.info.verify ?? ''), session.info.verify);

  // The real test: the SAME handle still drives the agent.
  const afterBlip = await session.prompt('Append one more line.');
  check('the same handle still prompts the agent', afterBlip.includes('Done.'), afterBlip.slice(0, 80));
  const blipMemory = await session.history();
  check(
    'the conversation from before the blip is intact',
    blipMemory.some((entry) => entry.text.includes('cinnabar')),
    blipMemory.length,
  );

  session.close();
  blipUser.close();
  await blipDaemon.stop();
  await blip.close();
}

console.log('\n13. delegated sessions');
{
  const delegatedOrigin = 'https://delegated.test';
  const delegateKeys = generateKeyPair();
  const delegatedWallet = new AgentWallet({ relayUrl, userSecretKey: delegateKeys.secretKey, socketFactory });
  await delegatedWallet.connect();
  // The grant is built once and approved once: the wallet signs its hash, so
  // this exact object must be the one that reaches session.open.
  const delegatedGrant = buildGrant({ surface: { name: 'Delegated Inkwell' }, tools: inkwellTools() });
  const delegation = signDelegation(user.secretKey, {
    delegate: delegateKeys.publicKey,
    agent: agentKeys.publicKey,
    origin: delegatedOrigin,
    grantHash: hashGrant(delegatedGrant),
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  const pagePayload = { agent: agentKeys.publicKey, displayName: 'Personal agent' as const, delegation };
  check(
    'the delegation payload handed to the page contains no root user pubkey',
    !('user' in pagePayload.delegation) && !JSON.stringify(pagePayload).includes(user.publicKey),
    Object.keys(pagePayload.delegation),
  );
  const pageApprovals: string[] = [];
  const delegated = await delegatedWallet.openSession({
    agent: agentKeys.publicKey,
    approved: { delegation, grant: delegatedGrant },
    surface: { name: 'Delegated Inkwell', origin: delegatedOrigin },
    tools: inkwellTools(),
    decide: async (prompt) => {
      pageApprovals.push(prompt.call?.name ?? prompt.summary);
      return true;
    },
  });
  check('a user-signed delegation opens from the ephemeral page key', delegated.info.agentName === 'Personal agent', delegated.info);

  doc.text = 'Delegated.';
  const localBefore = ownerLocalApprovals.length;
  await delegated.prompt('Approved in the panel.');
  check('delegated approvals are routed to the client', pageApprovals.length > 0, pageApprovals);
  check('delegated approvals never use onLocalApproval', ownerLocalApprovals.length === localBefore, ownerLocalApprovals);
  check('the delegated client can complete its granted tool call', doc.text.endsWith('Approved in the panel.'), doc.text);

  const expiredKeys = generateKeyPair();
  const expiredWallet = new AgentWallet({ relayUrl, userSecretKey: expiredKeys.secretKey, socketFactory });
  await expiredWallet.connect();
  const emptyGrant = buildGrant({ surface: { name: 'Expired' }, tools: [] });
  let relayExpired = '';
  await expiredWallet
    .openSession({
      agent: agentKeys.publicKey,
      approved: {
        grant: emptyGrant,
        delegation: signDelegation(user.secretKey, {
          delegate: expiredKeys.publicKey,
          agent: agentKeys.publicKey,
          origin: 'https://expired.test',
          grantHash: hashGrant(emptyGrant),
          expiresAt: Date.now() - 60_000,
        }),
      },
      surface: { name: 'Expired', origin: 'https://expired.test' },
      tools: [],
    })
    .catch((err: Error) => {
      relayExpired = err.message;
    });
  check('the relay refuses an expired delegation', relayExpired.includes('not_your_agent'), relayExpired);

  const wrongKeys = generateKeyPair();
  const wrongWallet = new AgentWallet({ relayUrl, userSecretKey: wrongKeys.secretKey, socketFactory });
  await wrongWallet.connect();
  const wrongGrant = buildGrant({ surface: { name: 'Wrong delegate' }, tools: [] });
  let wrongDelegate = '';
  await wrongWallet
    .openSession({
      agent: agentKeys.publicKey,
      approved: {
        grant: wrongGrant,
        delegation: signDelegation(user.secretKey, {
          delegate: generateKeyPair().publicKey,
          agent: agentKeys.publicKey,
          origin: 'https://wrong.test',
          grantHash: hashGrant(wrongGrant),
          expiresAt: Date.now() + 60_000,
        }),
      },
      surface: { name: 'Wrong delegate', origin: 'https://wrong.test' },
      tools: [],
    })
    .catch((err: Error) => {
      wrongDelegate = err.message;
    });
  check('the relay refuses a delegation for another page key', wrongDelegate.includes('not_your_agent'), wrongDelegate);

  const otherAgentKeys = generateKeyPair();
  const otherCert = signCert(user.secretKey, {
    user: user.publicKey,
    agent: otherAgentKeys.publicKey,
    name: 'Other owned agent',
    runtime: 'demo-writer',
    location: 'Personal VPS',
    issuedAt: Date.now(),
  });
  const otherDaemon = new AgentDaemon({
    relayUrl,
    identity: {
      secretKey: otherAgentKeys.secretKey,
      publicKey: otherAgentKeys.publicKey,
      name: 'Other owned agent',
      runtime: 'demo-writer',
      location: 'Personal VPS',
      cert: otherCert,
    },
    createRuntime: () => new DemoWriterRuntime(),
  });
  await otherDaemon.start();
  let wrongAgent = '';
  await delegatedWallet
    .openSession({
      agent: otherAgentKeys.publicKey,
      approved: { delegation, grant: delegatedGrant },
      surface: { name: 'Agent replay', origin: delegatedOrigin },
      tools: [],
    })
    .catch((err: Error) => {
      wrongAgent = err.message;
    });
  check('the relay refuses a delegation replayed toward a different owned agent', wrongAgent.includes('not_your_agent'), wrongAgent);

  let wrongOrigin = '';
  await delegatedWallet
    .openSession({
      agent: agentKeys.publicKey,
      approved: { delegation, grant: delegatedGrant },
      surface: { name: 'Origin replay', origin: 'https://other-origin.test' },
      tools: [],
    })
    .catch((err: Error) => {
      wrongOrigin = err.message;
    });
  check('the daemon refuses a delegation presented from a mismatched origin', wrongOrigin.includes('bad_delegation'), wrongOrigin);

  // The attack the signed grantHash exists to stop: the page holds a live
  // delegation the user approved for a small toolset, and opens the session
  // with a larger one. The user answered a question about grant A; without
  // the binding the signature would authorise grant B.
  let swappedGrant = '';
  const upgradedGrant = buildGrant({
    surface: { name: 'Grant swap' },
    tools: [
      ...inkwellTools(),
      {
        name: 'inkwell.document.wipe',
        description: 'Erase the document. Never approved by the user.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ ok: true }),
      },
    ],
  });
  await delegatedWallet
    .openSession({
      agent: agentKeys.publicKey,
      // Authority for delegatedGrant, presented with a strictly larger grant.
      approved: { delegation, grant: upgradedGrant },
      surface: { name: 'Grant swap', origin: delegatedOrigin },
      tools: [],
    })
    .catch((err: Error) => {
      swappedGrant = err.message;
    });
  check(
    'a page cannot open with a grant the user never approved',
    swappedGrant.includes('not_your_agent'),
    swappedGrant,
  );

  // A deliberately dishonest relay clock treats an already-expired statement
  // as live and forwards it over real sockets. The daemon's independent real-
  // time check must still stop the session at the edge.
  const lyingRelay = new Relay({ port: 0, log: () => {}, now: () => 0 });
  await lyingRelay.listening();
  const lyingUrl = `ws://127.0.0.1:${lyingRelay.port}`;
  const edgeDaemon = new AgentDaemon({
    relayUrl: lyingUrl,
    identity: {
      secretKey: agentKeys.secretKey,
      publicKey: agentKeys.publicKey,
      name: "Goga's Writing Agent",
      runtime: 'demo-writer',
      location: 'Personal VPS',
      cert,
    },
    createRuntime: () => new DemoWriterRuntime(),
  });
  await edgeDaemon.start();

  const edgeKeys = generateKeyPair();
  const edgeWallet = new AgentWallet({ relayUrl: lyingUrl, userSecretKey: edgeKeys.secretKey, socketFactory });
  await edgeWallet.connect();
  const edgeGrant = buildGrant({ surface: { name: 'Hostile relay bypass' }, tools: [] });
  let daemonExpired = '';
  await edgeWallet
    .openSession({
      agent: agentKeys.publicKey,
      approved: {
        grant: edgeGrant,
        delegation: signDelegation(user.secretKey, {
          delegate: edgeKeys.publicKey,
          agent: agentKeys.publicKey,
          origin: 'https://edge.test',
          grantHash: hashGrant(edgeGrant),
          expiresAt: Date.now() - 60_000,
        }),
      },
      surface: { name: 'Hostile relay bypass', origin: 'https://edge.test' },
      tools: [],
    })
    .catch((err: Error) => {
      daemonExpired = err.message;
    });
  check('the daemon independently refuses an expired delegation', daemonExpired.includes('bad_delegation'), daemonExpired);

  // Invariant 6 for the grant: the relay's own hash check is a convenience,
  // not the boundary. A relay that forwards a grant other than the one the
  // user signed must gain nothing — the daemon recomputes the hash itself.
  // The substitution is re-encoded canonically so the frame is rejected for
  // the delegation mismatch and not merely for its spelling.
  const { WebSocketServer: SwapServer } = await import('ws');
  const swapProxy = new SwapServer({ port: 0, host: '127.0.0.1' });
  const substituted = buildGrant({
    surface: { name: 'Substituted' },
    tools: [
      {
        name: 'inkwell.document.wipe',
        description: 'Erase the document. The user signed no such grant.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ ok: true }),
      },
    ],
  });
  swapProxy.on('connection', (inbound) => {
    const upstream = new NodeWebSocket(relayUrl);
    const queued: string[] = [];
    upstream.on('open', () => {
      for (const m of queued.splice(0)) upstream.send(m);
    });
    inbound.on('message', (data) => {
      const message = data.toString();
      if (upstream.readyState === NodeWebSocket.OPEN) upstream.send(message);
      else queued.push(message);
    });
    upstream.on('message', (data) => {
      const message = data.toString();
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed['t'] === 'session.open') {
        inbound.send(canonicalJson({ ...parsed, grant: substituted }));
        return;
      }
      inbound.send(message);
    });
    const drop = () => {
      if (upstream.readyState === NodeWebSocket.OPEN) upstream.close();
    };
    inbound.on('close', drop);
    inbound.on('error', drop);
    upstream.on('close', () => inbound.close());
    upstream.on('error', () => inbound.close());
  });
  await new Promise<void>((resolve) => swapProxy.once('listening', () => resolve()));
  const swapPort = (swapProxy.address() as { port: number }).port;

  const swapAgentKeys = generateKeyPair();
  const swapCert = signCert(user.secretKey, {
    user: user.publicKey,
    agent: swapAgentKeys.publicKey,
    name: 'Swap target',
    runtime: 'demo-writer',
    location: 'Personal VPS',
    issuedAt: Date.now(),
  });
  const swapDaemon = new AgentDaemon({
    relayUrl: `ws://127.0.0.1:${swapPort}`,
    identity: {
      secretKey: swapAgentKeys.secretKey,
      publicKey: swapAgentKeys.publicKey,
      name: 'Swap target',
      runtime: 'demo-writer',
      location: 'Personal VPS',
      cert: swapCert,
    },
    createRuntime: () => new DemoWriterRuntime(),
  });
  await swapDaemon.start();

  const swapPageKeys = generateKeyPair();
  const swapWallet = new AgentWallet({ relayUrl, userSecretKey: swapPageKeys.secretKey, socketFactory });
  await swapWallet.connect();
  const honestGrant = buildGrant({ surface: { name: 'Honest' }, tools: inkwellTools() });
  let relaySwapped = '';
  await swapWallet
    .openSession({
      agent: swapAgentKeys.publicKey,
      approved: {
        grant: honestGrant,
        delegation: signDelegation(user.secretKey, {
          delegate: swapPageKeys.publicKey,
          agent: swapAgentKeys.publicKey,
          origin: 'https://honest.test',
          grantHash: hashGrant(honestGrant),
          expiresAt: Date.now() + 60_000,
        }),
      },
      surface: { name: 'Honest', origin: 'https://honest.test' },
      tools: inkwellTools(),
    })
    .catch((err: Error) => {
      relaySwapped = err.message;
    });
  check(
    'the daemon refuses a grant the relay substituted for the signed one',
    relaySwapped.includes('bad_delegation'),
    relaySwapped,
  );

  swapWallet.close();
  await swapDaemon.stop();
  await new Promise<void>((resolve) => swapProxy.close(() => resolve()));

  delegated.close();
  delegatedWallet.close();
  expiredWallet.close();
  wrongWallet.close();
  edgeWallet.close();
  await otherDaemon.stop();
  await edgeDaemon.stop();
  await lyingRelay.close();
}

// --- 14. attachment identity is explicit -----------------------------------
console.log('\n14. detached tool calls fail without heuristic ownership transfer');
{
  const isolated = new Relay({ port: 0, sink: () => {} });
  await isolated.listening();
  const isolatedUrl = `ws://127.0.0.1:${isolated.port}`;
  const isolatedUser = generateKeyPair();
  const isolatedAgent = generateKeyPair();
  const isolatedCert = signCert(isolatedUser.secretKey, {
    user: isolatedUser.publicKey,
    agent: isolatedAgent.publicKey,
    name: 'Detach Agent',
    runtime: 'blocking-test',
    issuedAt: Date.now(),
  });
  const toolReachedPage = new Deferred<void>();
  const toolRejected = new Deferred<string>();
  let runtimeOpens = 0;
  let runtimeCloses = 0;

  class BlockingRuntime implements AgentRuntime {
    readonly name = 'blocking-test';
    openSession(): void {
      runtimeOpens++;
    }
    async prompt(_text: string, ctx: TurnContext): Promise<void> {
      try {
        await ctx.callTool('page.read', {});
      } catch (err) {
        toolRejected.resolve(err instanceof Error ? err.message : String(err));
      }
    }
    closeSession(): void {
      runtimeCloses++;
    }
  }

  const detachDaemon = new AgentDaemon({
    relayUrl: isolatedUrl,
    identity: {
      ...isolatedAgent,
      name: 'Detach Agent',
      runtime: 'blocking-test',
      cert: isolatedCert,
    },
    createRuntime: () => new BlockingRuntime(),
  });
  await detachDaemon.start();

  let clientSocket: NodeWebSocket | undefined;
  const disconnectingFactory = (url: string) => {
    clientSocket = new NodeWebSocket(url);
    return clientSocket as never;
  };
  const firstWallet = new AgentWallet({
    relayUrl: isolatedUrl,
    userSecretKey: isolatedUser.secretKey,
    socketFactory: disconnectingFactory,
  });
  await firstWallet.connect();
  const hangingTool: SiteTool = {
    name: 'page.read',
    description: 'A page call whose document disappears while it is running',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      toolReachedPage.resolve();
      return new Promise(() => {});
    },
  };
  const firstSession = await firstWallet.openSession({
    agent: isolatedAgent.publicKey,
    surface: { name: 'Reloading Page', origin: 'https://reload.test' },
    tools: [hangingTool],
  });
  void firstSession.prompt('read').catch(() => {});
  await toolReachedPage.promise;
  clientSocket!.terminate();

  const detachedError = await Promise.race([
    toolRejected.promise,
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
  ]);
  check('a tool awaiting a vanished page is rejected promptly', detachedError === 'client detached', detachedError);

  const replacementWallet = new AgentWallet({
    relayUrl: isolatedUrl,
    userSecretKey: isolatedUser.secretKey,
    socketFactory,
  });
  await replacementWallet.connect();
  const replacement = await replacementWallet.openSession({
    agent: isolatedAgent.publicKey,
    surface: { name: 'Reloading Page', origin: 'https://reload.test' },
    tools: [hangingTool],
  });
  check('a new attachment receives a distinct runtime', runtimeOpens === 2, runtimeOpens);
  check('surface labels never identify or retire the orphan', runtimeCloses === 0, runtimeCloses);

  replacement.close();
  firstWallet.close();
  replacementWallet.close();
  await detachDaemon.stop();
  check('concurrent client and daemon close tears down each runtime once', runtimeCloses === 2, runtimeCloses);
  await isolated.close();
}

// --- teardown ---------------------------------------------------------------

session.close();
stranger.close();
wallet.close();
await daemon.stop();
await relay.close();

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
