/**
 * End-to-end exercise of the whole loop:
 *
 *   pair -> discover -> grant -> prompt -> agent calls a site tool ->
 *   approval round-trip -> document mutated in the "browser"
 *
 * Runs relay + daemon + wallet in one process over real WebSockets.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import { Relay } from '../packages/relay/src/relay.js';
import { AgentDaemon } from '../packages/daemon/src/daemon.js';
import { DemoWriterRuntime } from '../packages/daemon/src/runtime.js';
import { AgentWallet, type SiteTool } from '../packages/client/src/index.js';
import { Deferred, generateKeyPair, signCert, signDelegation, type Hex } from '../packages/protocol/src/index.js';

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

const relay = new Relay({ port: 0, log: () => {} });
await relay.listening();
const relayUrl = `ws://127.0.0.1:${relay.port}`;
console.log(`relay on ${relayUrl}\n`);

const user = generateKeyPair();
const agentKeys = generateKeyPair();

const pairingCode = new Deferred<string>();
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
  onPairingCode: (code) => pairingCode.resolve(code),
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

console.log('\n4. prompt -> tool loop');
const reply = await session.prompt('Then the wind rose.');
check('agent read the document', toolEvents.includes('inkwell.document.read:true'), toolEvents);
check('write was approved', approvals.length > 0, approvals);
check('document was mutated in the page', doc.text.endsWith('Then the wind rose.'), doc.text);
check('agent streamed a reply', reply.includes('Done.'), reply);

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
// inside TLS termination) sees. If sealing works, the conversation text, tool
// names and frame types never appear on the wire in either direction.
console.log('\n10. the relay is blind (ADR-003)');
{
  const { WebSocketServer: TapServer } = await import('ws');
  const observed: string[] = [];
  const tap = new TapServer({ port: 0, host: '127.0.0.1' });
  tap.on('connection', (inbound) => {
    const upstream = new NodeWebSocket(relayUrl);
    const up: string[] = [];
    upstream.on('open', () => { for (const m of up.splice(0)) upstream.send(m); });
    inbound.on('message', (data) => {
      observed.push(data.toString());
      if (upstream.readyState === NodeWebSocket.OPEN) upstream.send(data.toString());
      else up.push(data.toString());
    });
    upstream.on('message', (data) => {
      observed.push(data.toString());
      inbound.send(data.toString());
    });
    inbound.on('close', () => upstream.close());
    upstream.on('close', () => inbound.close());
  });
  await new Promise((resolve) => tap.on('listening', resolve));
  const tapUrl = `ws://127.0.0.1:${(tap.address() as { port: number }).port}`;

  const sealKeys = generateKeyPair();
  const sealPairing = new Deferred<string>();
  const sealDaemon = new AgentDaemon({
    relayUrl,
    identity: { ...sealKeys, name: 'Sealed Agent', runtime: 'demo-writer' },
    createRuntime: () => new DemoWriterRuntime(),
    onPairingCode: (code) => sealPairing.resolve(code),
  });
  await sealDaemon.start();

  const sealUser = generateKeyPair();
  const observedWallet = new AgentWallet({ relayUrl: tapUrl, userSecretKey: sealUser.secretKey, socketFactory });
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
  check('the sealed session has fingerprint words', /^\w+-\w+-\w+$/.test(sealedSession.info.verify ?? ''), sealedSession.info.verify);
  await sealedSession.prompt(SECRET);

  const wire = observed.join('\n');
  check('conversation text never crossed the wire in the clear', !wire.includes('launch codes'));
  check('tool names never crossed the wire in session traffic', !wire.includes('replaceSelection') || !observed.some((m) => m.includes('"t":"tool.call"')));
  check('content frame types are hidden', !observed.some((m) => /"t":"(delta|prompt|tool\.call|tool\.result|approval)/.test(m)));
  check('sealed frames did cross it', observed.filter((m) => m.includes('"t":"enc"')).length >= 4, observed.filter((m) => m.includes('"t":"enc"')).length);

  sealedSession.close();
  observedWallet.close();
  await sealDaemon.stop();
  tap.close();
}

// --- 11. a relay redeploy does not strand the daemon --------------------------
// Deploying the Worker kills the Durable Object and severs every socket. The
// daemon must notice and come back on its own — no human restarting npx.
console.log('\n11. relay restarts are survived');
{
  const { Relay: FreshRelay } = await import('../packages/relay/src/relay.js');
  const bounce = new FreshRelay({ port: 0, log: () => {} });
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
  const revived = new FreshRelay({ port, log: () => {} });
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
  const r1 = new FreshRelay({ port: 0, log: () => {} });
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
  const r2 = new FreshRelay({ port: relayPort, log: () => {} });
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
    requireSealed: true,
  });
  check('the session resumed through a relay that never saw it', after.info.agentName === 'Survivor Agent');
  check('and it resumed SEALED', /^\w+-\w+-\w+$/.test(after.info.verify ?? ''), after.info.verify);
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

console.log('\n13. delegated sessions');
{
  const delegatedOrigin = 'https://delegated.test';
  const delegateKeys = generateKeyPair();
  const delegatedWallet = new AgentWallet({ relayUrl, userSecretKey: delegateKeys.secretKey, socketFactory });
  await delegatedWallet.connect();
  const delegation = signDelegation(user.secretKey, {
    delegate: delegateKeys.publicKey,
    agent: agentKeys.publicKey,
    origin: delegatedOrigin,
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
    delegation,
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
  let relayExpired = '';
  await expiredWallet
    .openSession({
      agent: agentKeys.publicKey,
      delegation: signDelegation(user.secretKey, {
        delegate: expiredKeys.publicKey,
        agent: agentKeys.publicKey,
        origin: 'https://expired.test',
        expiresAt: Date.now() - 60_000,
      }),
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
  let wrongDelegate = '';
  await wrongWallet
    .openSession({
      agent: agentKeys.publicKey,
      delegation: signDelegation(user.secretKey, {
        delegate: generateKeyPair().publicKey,
        agent: agentKeys.publicKey,
        origin: 'https://wrong.test',
        expiresAt: Date.now() + 60_000,
      }),
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
      delegation,
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
      delegation,
      surface: { name: 'Origin replay', origin: 'https://other-origin.test' },
      tools: [],
    })
    .catch((err: Error) => {
      wrongOrigin = err.message;
    });
  check('the daemon refuses a delegation presented from a mismatched origin', wrongOrigin.includes('bad_delegation'), wrongOrigin);

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
  let daemonExpired = '';
  await edgeWallet
    .openSession({
      agent: agentKeys.publicKey,
      delegation: signDelegation(user.secretKey, {
        delegate: edgeKeys.publicKey,
        agent: agentKeys.publicKey,
        origin: 'https://edge.test',
        expiresAt: Date.now() - 60_000,
      }),
      surface: { name: 'Hostile relay bypass', origin: 'https://edge.test' },
      tools: [],
    })
    .catch((err: Error) => {
      daemonExpired = err.message;
    });
  check('the daemon independently refuses an expired delegation', daemonExpired.includes('bad_delegation'), daemonExpired);

  delegated.close();
  delegatedWallet.close();
  expiredWallet.close();
  wrongWallet.close();
  edgeWallet.close();
  await otherDaemon.stop();
  await edgeDaemon.stop();
  await lyingRelay.close();
}

// --- teardown ---------------------------------------------------------------

session.close();
stranger.close();
wallet.close();
await daemon.stop();
await relay.close();

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
