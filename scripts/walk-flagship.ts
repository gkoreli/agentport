/**
 * The flagship-demo attempt, as far as honesty allows: the user's OWN agent,
 * on their own machine, attached to a real storefront that has never heard of
 * AgentPort, using the tools the storefront's platform registered via WebMCP.
 *
 * A person's instrument, NOT a CI gate (live network, a real model turn, a
 * third-party site that changes without notice). Findings land in
 * `docs/reviews/webmcp-supply-walk.md`.
 *
 * WHAT IS SEEDED AND WHY THAT IS HONEST. The pairing ROUND-TRIP is not
 * exercised here: both endpoints are seeded with pairing's outcome — the
 * extension gets the user key and the stored cert, the daemon gets an identity
 * file's worth of state with the user-signed cert — because pairing is already
 * proven end to end (`scripts/e2e.ts`) and the thing this walk exists to
 * observe is the attach + grant + turn on a page nobody prepared. Everything
 * from `navigator.agent.connect()` onward is the real path: real relay, real
 * daemon, real ACP agent (Claude Code, authenticated on this machine), real
 * consent chrome, real approvals, sealed frames.
 *
 * READ-ONLY DISCIPLINE: the prompt asks a catalog question; per-call approvals
 * are granted ONLY for the read-shaped tools named in READ_ONLY_TOOLS. Every
 * other request is declined. Nothing is carted, ordered, or checked out.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { generateKeyPair, signCert } from '../packages/protocol/src/index.js';
import { Relay } from '../packages/relay/src/relay.js';
import { AgentDaemon } from '../packages/daemon/src/daemon.js';
import { registerAcpRuntimes, resolveAcpSpawn } from '../packages/daemon/src/acp-preflight.js';
import { McpBridge } from '../packages/daemon/src/mcp-bridge.js';
import { RUNTIMES } from '../packages/daemon/src/runtime.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION = join(ROOT, 'packages/extension/dist');
const ASSETS = join(ROOT, 'docs/reviews/assets');
const TARGET_URL = process.argv[2] ?? 'https://www.allbirds.com/';
const CDP_TIMEOUT_MS = 30_000;
const PAGE_LOAD_MS = 25_000;
const CONSENT_WINDOW_MS = 30_000;
/** A real model turn against a real page: minutes, not seconds. Bounded. */
const TURN_MS = 240_000;
/** The only tools a per-call approval will be granted for. Reads, never writes. */
const READ_ONLY_TOOLS = new Set(['search_catalog', 'get_product', 'browse_store', 'search_shop_policies_and_faqs']);
/** How many approvals the walk will grant before declining the rest. */
const MAX_APPROVALS = 3;

type JsonObject = Record<string, unknown>;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { code: number; message: string };
  sessionId?: string;
}

class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; resolve: (v: JsonObject) => void; reject: (e: Error) => void }
  >();
  #nextId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as CdpMessage;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    socket.on('close', () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome DevTools connection closed'));
      }
      this.#pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once('open', resolveOpen);
      socket.once('error', rejectOpen);
    });
    return new CdpClient(socket);
  }

  send(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    const id = ++this.#nextId;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        rejectResult(new Error(`CDP ${method} did not answer within ${CDP_TIMEOUT_MS}ms`));
      }, CDP_TIMEOUT_MS);
      this.#pending.set(id, { timer, resolve: resolveResult, reject: rejectResult });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolveClose) => {
      this.#socket.once('close', resolveClose);
      this.#socket.close();
    });
  }
}

async function walkForChrome(root: string): Promise<string | undefined> {
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && (entry.name === 'chrome' || entry.name === 'Google Chrome for Testing')) {
        try {
          await access(path);
          return path;
        } catch {
          /* keep looking */
        }
      }
      if (entry.isDirectory() && current.depth < 8) queue.push({ path, depth: current.depth + 1 });
    }
  }
  return undefined;
}

async function chromeExecutable(): Promise<string> {
  const configured = process.env['AGENTPORT_CHROME'];
  if (configured) {
    const path = resolve(configured);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`AGENTPORT_CHROME is not a file: ${path}`);
    return path;
  }
  const discovered = await walkForChrome('/tmp/agentport-cft');
  if (discovered) return discovered;
  throw new Error('Set AGENTPORT_CHROME or unpack Chrome for Testing under /tmp/agentport-cft');
}

async function devtoolsEndpoint(profile: string, child: ChildProcess): Promise<string> {
  const file = join(profile, 'DevToolsActivePort');
  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited with ${child.exitCode ?? child.signalCode ?? 'unknown'}`);
    }
    const contents = await readFile(file, 'utf8').catch(() => '');
    const [port, path] = contents.trim().split(/\r?\n/);
    if (port && path) return `ws://127.0.0.1:${port}${path}`;
    if (Date.now() - startedAt > CDP_TIMEOUT_MS) throw new Error('Chrome never exposed a DevTools endpoint');
    await delay(50);
  }
}

function remoteValue(response: JsonObject): unknown {
  const exception = response['exceptionDetails'];
  if (exception && typeof exception === 'object') {
    const details = exception as JsonObject;
    const thrown = details['exception'] as JsonObject | undefined;
    const description = thrown ? String(thrown['description'] ?? thrown['value'] ?? '') : '';
    throw new Error(`evaluate failed: ${String(details['text'] ?? 'unknown')} ${description}`.trim());
  }
  const result = response['result'];
  return result && typeof result === 'object' ? (result as JsonObject)['value'] : undefined;
}

interface FoundTarget {
  targetId: string;
  url: string;
  type: string;
}

async function listTargets(client: CdpClient): Promise<FoundTarget[]> {
  const response = await client.send('Target.getTargets');
  const infos = response['targetInfos'];
  if (!Array.isArray(infos)) return [];
  return infos
    .map((raw) => raw as JsonObject)
    .map((raw) => ({ targetId: String(raw['targetId']), url: String(raw['url']), type: String(raw['type']) }));
}

async function attach(client: CdpClient, targetId: string): Promise<string> {
  const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
  return String(attached['sessionId']);
}

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string, userGesture = false): Promise<T> {
  const response = await client.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture },
    sessionId,
  );
  return remoteValue(response) as T;
}

async function screenshot(client: CdpClient, sessionId: string, name: string): Promise<void> {
  try {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const data = shot['data'];
    if (typeof data === 'string') {
      await writeFile(join(ASSETS, name), Buffer.from(data, 'base64'));
      console.log(`   screenshot ${name}`);
    }
  } catch (err) {
    console.log(`   screenshot ${name} failed: ${String(err instanceof Error ? err.message : err)}`);
  }
}

/**
 * Watch for extension consent windows and answer them: the connect picker is
 * approved (the seeded agent is the only one and arrives preselected), and
 * per-call approvals are granted only for READ_ONLY_TOOLS, MAX_APPROVALS
 * times, declined otherwise. Returns a stop function.
 */
function driveConsent(client: CdpClient, extensionOrigin: string, log: (line: string) => void): () => void {
  const answered = new Set<string>();
  let approvals = 0;
  let stopped = false;
  void (async () => {
    while (!stopped) {
      await delay(500);
      let targets: FoundTarget[];
      try {
        targets = await listTargets(client);
      } catch {
        continue;
      }
      for (const target of targets) {
        if (stopped) return;
        if (!target.url.startsWith(`${extensionOrigin}/consent.html`)) continue;
        if (answered.has(target.targetId)) continue;
        answered.add(target.targetId);
        try {
          const sessionId = await attach(client, target.targetId);
          // Let the window fetch and render its payload first.
          const rendered = await (async () => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 10_000) {
              const kind = await evaluate<string>(
                client,
                sessionId,
                `(() => {
                  const approve = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Approve');
                  if (!approve) return 'pending';
                  return document.body.innerText.slice(0, 2000);
                })()`,
              ).catch(() => 'pending');
              if (kind !== 'pending') return kind;
              await delay(250);
            }
            return 'never-rendered';
          })();
          if (rendered === 'never-rendered') {
            log(`consent window ${target.targetId} never rendered an Approve button`);
            continue;
          }
          const isCallApproval = /asks to run|wants to use|approval/i.test(rendered) && /\(/.test(rendered);
          const namedReadOnly = [...READ_ONLY_TOOLS].some((tool) => rendered.includes(tool));
          const isConnect = /wants your agent|Connect|agent/i.test(rendered) && !isCallApproval;
          await screenshot(client, sessionId, `flagship-consent-${answered.size}.png`);
          let action: 'approve' | 'decline';
          if (isConnect && approvals === 0 && !isCallApproval) action = 'approve';
          else if (namedReadOnly && approvals < MAX_APPROVALS) {
            approvals += 1;
            action = 'approve';
          } else action = 'decline';
          log(`consent window: ${action} (${rendered.split('\n').slice(0, 3).join(' / ').slice(0, 160)})`);
          await evaluate(
            client,
            sessionId,
            action === 'approve'
              ? `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Approve')?.click()`
              : `[...document.querySelectorAll('button')].find((b) => /Decline|Skip/.test(b.textContent ?? ''))?.click()`,
            true,
          );
        } catch (err) {
          log(`consent drive failed: ${String(err instanceof Error ? err.message : err)}`);
        }
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

async function main(): Promise<void> {
  await access(join(EXTENSION, 'manifest.json')).catch(() => {
    throw new Error('build the extension first: npm run build:extension');
  });
  await mkdir(ASSETS, { recursive: true });

  // --- the user's side of a completed pairing, generated fresh -------------
  const user = generateKeyPair();
  const agent = generateKeyPair();
  const cert = signCert(user.secretKey, {
    user: user.publicKey,
    agent: agent.publicKey,
    name: 'Walk Agent (Claude Code)',
    runtime: 'claude-code',
    location: 'this laptop',
    issuedAt: Date.now(),
  });

  // --- relay + daemon, in process, real ACP runtime ------------------------
  const relay = new Relay({ port: 0, sink: () => {} });
  await relay.listening();
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const acp = resolveAcpSpawn(process.env);
  if (typeof acp === 'string') throw new Error(acp);
  registerAcpRuntimes(acp, new McpBridge());
  const createRuntime = RUNTIMES['claude-code'];
  if (!createRuntime) throw new Error('claude-code runtime is not registered');
  const daemon = new AgentDaemon({
    relayUrl,
    identity: {
      publicKey: agent.publicKey,
      secretKey: agent.secretKey,
      name: 'Walk Agent (Claude Code)',
      runtime: 'claude-code',
      location: 'this laptop',
      cert,
    },
    createRuntime,
    sink: () => {},
  });
  const { bound } = await daemon.start();
  console.log(`daemon online at ${relayUrl}, pre-bound=${bound}`);

  // --- Chrome with the extension, storage seeded ---------------------------
  const chrome = await chromeExecutable();
  const temporary = await mkdtemp(join(tmpdir(), 'agentport-flagship-'));
  const profile = join(temporary, 'profile');
  const args = [
    '--headless=new',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions-except=' + EXTENSION,
    '--load-extension=' + EXTENSION,
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ];
  console.log(`launching ${basename(chrome)}`);
  const browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let client: CdpClient | undefined;
  let stopConsent: (() => void) | undefined;
  const consentLog: string[] = [];
  try {
    client = await CdpClient.connect(await devtoolsEndpoint(profile, browser));

    // Find the extension service worker to learn the extension origin and to
    // seed storage exactly as a completed pairing would have left it.
    const swTarget = await (async () => {
      const startedAt = Date.now();
      for (;;) {
        const targets = await listTargets(client!);
        const found = targets.find(
          (target) =>
            target.type === 'service_worker' &&
            target.url.startsWith('chrome-extension://') &&
            target.url.endsWith('/sw.js'),
        );
        if (found) return found;
        if (Date.now() - startedAt > CDP_TIMEOUT_MS) throw new Error('extension service worker never appeared');
        await delay(200);
      }
    })();
    // URL.origin is the literal string "null" for non-special schemes like
    // chrome-extension:; assemble the origin by hand.
    const extensionOrigin = swTarget.url.slice(0, swTarget.url.indexOf('/', 'chrome-extension://'.length));
    console.log(`extension SW at ${swTarget.url} → origin ${extensionOrigin}`);
    // Seed via an extension PAGE context: a service-worker CDP session does
    // not reliably expose chrome.* bindings in headless, while popup.html has
    // them by construction. Opening it also spins the worker up.
    const seederCreated = await client.send('Target.createTarget', { url: 'about:blank' });
    const seederId = String(seederCreated['targetId']);
    const seederSession = await attach(client, seederId);
    await client.send('Page.enable', {}, seederSession);
    // createTarget silently opens about:blank for chrome-extension URLs in
    // headless; an explicit navigation from the attached session works.
    await client.send('Page.navigate', { url: `${extensionOrigin}/popup.html` }, seederSession);
    await (async () => {
      const startedAt = Date.now();
      for (;;) {
        const ready = await evaluate<boolean>(
          client!,
          seederSession,
          `typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local`,
        ).catch(() => false);
        if (ready === true) return;
        if (Date.now() - startedAt > 10_000) {
          const diag = await evaluate<string>(
            client!,
            seederSession,
            `location.href + ' | chrome=' + typeof chrome + ' | keys=' + (typeof chrome !== 'undefined' ? Object.keys(chrome).join(',') : 'n/a')`,
          ).catch((err) => 'diag failed: ' + String(err instanceof Error ? err.message : err));
          throw new Error(`popup context never exposed chrome.storage — ${diag}`);
        }
        await delay(300);
      }
    })();
    const seeded = await evaluate<string>(
      client,
      seederSession,
      `chrome.storage.local.set(${JSON.stringify({
        'agentport.user.secretKey': user.secretKey,
        'agentport.relay.url': relayUrl,
        'agentport.certs': [
          { agent: agent.publicKey, name: 'Walk Agent (Claude Code)', runtime: 'claude-code', location: 'this laptop' },
        ],
        // Per-origin enablement is default OFF; seeding the walked origin is
        // the recorded outcome of the user-gesture toggle, same as the cert
        // is the recorded outcome of pairing.
        'agentport.enabled.origins.v1': [new URL(TARGET_URL).origin],
      })}).then(() => 'seeded', (err) => 'seed failed: ' + String(err))`,
    );
    if (seeded !== 'seeded') throw new Error(seeded);
    await client.send('Target.closeTarget', { targetId: seederId }).catch(() => {});
    console.log(`seeded extension at ${extensionOrigin} with relay ${relayUrl}`);

    stopConsent = driveConsent(client, extensionOrigin, (line) => {
      consentLog.push(line);
      console.log(`   ${line}`);
    });

    // --- the page nobody prepared -----------------------------------------
    const created = await client.send('Target.createTarget', { url: 'about:blank' });
    const pageId = String(created['targetId']);
    const pageSession = await attach(client, pageId);
    await client.send('Page.enable', {}, pageSession);
    let loaded = false;
    const socketListener = (raw: unknown) => void raw;
    void socketListener;
    // Reuse the polling shape: loadEventFired subscription needs an event
    // listener API this trimmed client lacks; poll readyState instead.
    await client.send('Page.navigate', { url: TARGET_URL }, pageSession);
    const startedAt = Date.now();
    while (Date.now() - startedAt < PAGE_LOAD_MS) {
      const state = await evaluate<string>(client, pageSession, 'document.readyState').catch(() => 'detached');
      if (state === 'complete') {
        loaded = true;
        break;
      }
      await delay(300);
    }
    console.log(`page loaded=${loaded}; letting the WebMCP adapter register`);
    await delay(4_000);
    await screenshot(client, pageSession, 'flagship-storefront.png');

    // --- connect: the page-provider tier, harvested tools merged in --------
    const connectOutcome = await evaluate<string>(
      client,
      pageSession,
      `(() => {
        window.__walkEvents = [];
        window.__walkAnswer = '';
        return navigator.agent.connect({ name: 'AgentPort Walk' }).then((session) => {
          window.__walkSession = session;
          session.on('delta', (delta) => {
            window.__walkAnswer += typeof delta === 'string' ? delta : (delta && delta.text ? delta.text : '');
          });
          session.on('tool', (call) => { window.__walkEvents.push('tool:' + JSON.stringify(call).slice(0, 120)); });
          return 'connected: ' + JSON.stringify(session.info ?? {});
        }, (err) => 'connect failed: ' + String(err && err.message ? err.message : err));
      })()`,
      true,
    );
    console.log(`connect → ${connectOutcome}`);
    if (!connectOutcome.startsWith('connected')) {
      throw new Error(`attach did not complete: ${connectOutcome}; consent log: ${consentLog.join(' | ')}`);
    }
    await screenshot(client, pageSession, 'flagship-attached.png');

    // --- one real turn ------------------------------------------------------
    console.log('running one real turn (bounded)');
    const turn = await evaluate<string>(
      client,
      pageSession,
      `Promise.race([
        window.__walkSession.prompt(
          'You are attached to this storefront. In two short sentences: what does this store sell, and name one product with its price. Use at most one catalog search tool call.',
        ).then(() => 'turn-complete', (err) => 'turn failed: ' + String(err && err.message ? err.message : err)),
        new Promise((resolveRace) => setTimeout(() => resolveRace('turn-timeout'), ${TURN_MS})),
      ])`,
      true,
    );
    const answer = await evaluate<string>(client, pageSession, 'window.__walkAnswer').catch(() => '');
    const events = await evaluate<string[]>(client, pageSession, 'window.__walkEvents').catch(() => []);
    console.log(`turn → ${turn}`);
    console.log(`agent said: ${answer.slice(0, 500)}`);
    for (const event of events) console.log(`   ${event}`);
    await screenshot(client, pageSession, 'flagship-answer.png');
    await evaluate(client, pageSession, 'window.__walkSession && window.__walkSession.close()').catch(() => {});

    console.log('\nRESULT', JSON.stringify({ loaded, connectOutcome, turn, answer, events, consentLog }, null, 1));
  } finally {
    stopConsent?.();
    await client?.close().catch(() => {});
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGTERM');
      const exited = new Promise<boolean>((resolveExit) => browser.once('exit', () => resolveExit(true)));
      if (!(await Promise.race([exited, delay(2_000).then(() => false)]))) browser.kill('SIGKILL');
    }
    await daemon.stop().catch(() => {});
    await relay.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
