/**
 * Walk the live WebMCP supply as a stranger with only our extension installed.
 *
 * A person's instrument, NOT a CI gate: it drives real third-party websites
 * over the live network, and what those sites serve changes without notice. It
 * must never appear in a gate list — a red here is a finding about the world,
 * not about this tree. The dated findings live in
 * `docs/reviews/webmcp-supply-walk.md`; this script is how they were produced
 * and how the next walker reproduces them.
 *
 *   npx tsx scripts/walk-webmcp.ts [url ...]
 *
 * With no arguments it walks the August-2026 supply the landscape research
 * pointed at: three Shopify Liquid storefronts (the adapter loader was found
 * in their served HTML by a plain curl), one non-Liquid storefront as the
 * negative control, and the two Chrome demo pages. For each URL, in a real
 * Chrome for Testing with the unpacked extension loaded, it answers:
 *
 *   - does `document.modelContext` / `navigator.modelContext` exist, and who
 *     supplied it (the browser, OUR shim, or a page polyfill);
 *   - what the registry's `getTools()` reports — i.e. what a user-supplied
 *     agent would actually be lent;
 *   - what the page's own supply believes (`window.Shopify.MCP.enabled`, the
 *     adapter's registered symbol);
 *   - what the extension's in-page ring buffer logged about the harvest.
 *
 * Every wait is bounded. A page that never finishes loading is walked anyway
 * at the deadline and reported with its readyState — a slow site is a
 * finding, not a hang.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION = join(ROOT, 'packages/extension/dist');
/** One CDP call. Generous: real sites answer slowly under first paint. */
const CDP_TIMEOUT_MS = 30_000;
/** How long a real page gets to reach `load` before being walked as-is. */
const PAGE_LOAD_MS = 25_000;
/** After load: the Shopify adapter defers registration to an idle callback. */
const SETTLE_MS = 4_000;

const DEFAULT_URLS = [
  // Shopify Liquid storefronts whose served HTML carries the adapter loader.
  'https://www.allbirds.com/',
  'https://kith.com/',
  'https://www.brooklinen.com/',
  // Negative control: a big storefront whose HTML carried no marker.
  'https://www.gymshark.com/',
  // Chrome's own demo pages (imperative API).
  'https://googlechromelabs.github.io/webmcp-tools/demos/explainer/',
  'https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/',
];

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
  readonly #listeners = new Set<(message: CdpMessage) => void>();
  #nextId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.#listeners) listener(message);
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

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    const id = ++this.#nextId;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        rejectResult(new Error(`CDP ${method} did not answer within ${CDP_TIMEOUT_MS}ms`));
      }, CDP_TIMEOUT_MS);
      this.#pending.set(id, {
        timer,
        resolve: resolveResult,
        reject: rejectResult,
      });
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
          // keep looking
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
  throw new Error(
    'Set AGENTPORT_CHROME to Chrome for Testing or unbranded Chromium, or unpack Chrome for Testing under /tmp/agentport-cft',
  );
}

async function devtoolsEndpoint(profile: string, child: ChildProcess): Promise<string> {
  const file = join(profile, 'DevToolsActivePort');
  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited with ${child.exitCode ?? child.signalCode ?? 'unknown status'}`);
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
    throw new Error(`Runtime.evaluate failed: ${String(details['text'] ?? 'unknown exception')}`);
  }
  const result = response['result'];
  return result && typeof result === 'object' ? (result as JsonObject)['value'] : undefined;
}

/** What one page told us. Every field is an observation, never an inference. */
interface WalkFinding {
  url: string;
  finalUrl: string;
  readyState: string;
  loadedWithinDeadline: boolean;
  documentModelContext: boolean;
  navigatorModelContext: boolean;
  /** True when the registry in place is OUR shim (it wraps or stands in). */
  registryIsOurShim: boolean;
  /** True when the browser itself supplies modelContext on a prototype. */
  nativeOnPrototype?: boolean;
  /** True when registerTool is OUR observe() wrapper rather than native. */
  registerToolWrapped?: boolean;
  /** Whether a canary registration became listable, or why it failed. */
  canaryListed?: boolean | string;
  shopifyMcpEnabled: boolean;
  shopifyAdapterRegistered: boolean;
  toolNames: string[];
  toolCount: number | 'unreadable';
  agentProviderPresent: boolean;
  harvestLog: string[];
  error?: string;
}

/**
 * The page-world probe. Serialized into the page, so it must be self-contained
 * ES2022 with no references to this file's scope.
 */
const PROBE = `(async () => {
  const out = {
    finalUrl: location.href,
    readyState: document.readyState,
    documentModelContext: 'modelContext' in document && !!document.modelContext,
    navigatorModelContext: 'modelContext' in navigator && !!navigator.modelContext,
    registryIsOurShim: false,
    shopifyMcpEnabled: !!(window.Shopify && window.Shopify.MCP && window.Shopify.MCP.enabled === true),
    shopifyAdapterRegistered: Reflect.get(window, Symbol.for('shopify.webmcp.registered')) === true,
    toolNames: [],
    toolCount: 'unreadable',
    agentProviderPresent: !!navigator.agent,
    harvestLog: [],
  };
  // Our shim installs the same object under BOTH spellings as non-enumerable
  // OWN properties; a native implementation lives on the prototype chain.
  // Both facts are observable without touching extension internals.
  try {
    const own = Object.getOwnPropertyDescriptor(document, 'modelContext');
    out.registryIsOurShim = !!own && own.enumerable === false && document.modelContext === navigator.modelContext;
    out.nativeOnPrototype =
      !!Object.getOwnPropertyDescriptor(Document.prototype, 'modelContext') ||
      !!Object.getOwnPropertyDescriptor(Navigator.prototype, 'modelContext');
    // Our harvest observes an existing registry by REPLACING its registerTool
    // with a recording wrapper (packages/client/src/webmcp.ts, observe). On an
    // untouched native registry that function stringifies as [native code];
    // wrapped, it does not. This is the page-visible proof that registrations
    // made after document_start flow through OUR harvester.
    const registry0 = document.modelContext ?? navigator.modelContext;
    out.registerToolWrapped = !!registry0 && !String(registry0.registerTool).includes('[native code]');
  } catch {}
  // A canary registration proves the register-then-list path live, whoever
  // supplies the registry. Page-local, withdrawn immediately via its signal.
  try {
    const registry = document.modelContext ?? navigator.modelContext;
    if (registry && registry.registerTool) {
      const abort = new AbortController();
      await Promise.resolve(registry.registerTool(
        {
          name: 'agentport_walk_canary',
          description: 'AgentPort supply-walk canary; registered and immediately withdrawn.',
          inputSchema: { type: 'object', properties: {} },
          execute: () => ({ content: [{ type: 'text', text: 'canary' }] }),
        },
        { signal: abort.signal },
      ));
      const listed = registry.getTools ? await registry.getTools() : [];
      out.canaryListed = Array.isArray(listed) &&
        listed.some((t) => (t && (t.name ?? (t.tool && t.tool.name))) === 'agentport_walk_canary');
      abort.abort();
    }
  } catch (err) {
    out.canaryListed = 'failed: ' + String(err && err.message ? err.message : err);
  }
  try {
    const registry = document.modelContext ?? navigator.modelContext;
    const listed = registry && registry.getTools ? await registry.getTools() : undefined;
    if (Array.isArray(listed)) {
      out.toolCount = listed.length;
      out.toolNames = listed
        .map((t) => (t && typeof t === 'object' ? (t.name ?? (t.tool && t.tool.name)) : undefined))
        .filter((n) => typeof n === 'string')
        .slice(0, 30);
    }
  } catch (err) {
    out.toolCount = 'unreadable';
    out.harvestLog.push('getTools threw: ' + String(err && err.message ? err.message : err));
  }
  try {
    const logs = window.__agentport && window.__agentport.logs ? window.__agentport.logs() : [];
    out.harvestLog = out.harvestLog.concat(
      logs
        .map((entry) => { try { return JSON.stringify(entry); } catch { return String(entry); } })
        .filter((line) => /webmcp|harvest|modelContext|tool/i.test(line))
        .slice(-8),
    );
  } catch {}
  return out;
})()`;

async function walkUrl(client: CdpClient, url: string): Promise<WalkFinding> {
  const finding: WalkFinding = {
    url,
    finalUrl: url,
    readyState: 'never-attached',
    loadedWithinDeadline: false,
    documentModelContext: false,
    navigatorModelContext: false,
    registryIsOurShim: false,
    shopifyMcpEnabled: false,
    shopifyAdapterRegistered: false,
    toolNames: [],
    toolCount: 'unreadable',
    agentProviderPresent: false,
    harvestLog: [],
  };
  let targetId: string | undefined;
  try {
    const created = await client.send('Target.createTarget', { url: 'about:blank' });
    targetId = String(created['targetId']);
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached['sessionId']);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    // Raise the extension's in-page ring buffer to debug BEFORE any document
    // script runs: 'webmcp tool harvested' logs at debug, and the default ring
    // drops it — without this, an empty harvest log is ambiguous between "saw
    // nothing" and "said nothing".
    await client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: "try { localStorage.setItem('agentport.log', 'debug'); } catch {}", runImmediately: false },
      sessionId,
    );

    let loaded = false;
    const off = client.onEvent((message) => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') loaded = true;
    });
    await client.send('Page.navigate', { url }, sessionId);
    const startedAt = Date.now();
    while (!loaded && Date.now() - startedAt < PAGE_LOAD_MS) await delay(200);
    off();
    finding.loadedWithinDeadline = loaded;
    // The Shopify adapter registers after DOMContentLoaded on a deferred
    // timeout; give a settled page a moment to finish that, bounded.
    await delay(SETTLE_MS);

    const response = await client.send(
      'Runtime.evaluate',
      { expression: PROBE, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    const value = remoteValue(response);
    if (value && typeof value === 'object') Object.assign(finding, value as Partial<WalkFinding>);
  } catch (err) {
    finding.error = String(err instanceof Error ? err.message : err);
  } finally {
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
  return finding;
}

async function main(): Promise<void> {
  const urls = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_URLS;
  await access(join(EXTENSION, 'manifest.json')).catch(() => {
    throw new Error('build the extension first: npm run build:extension');
  });
  const chrome = await chromeExecutable();
  const temporary = await mkdtemp(join(tmpdir(), 'agentport-walk-'));
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
  console.log(`walking with ${basename(chrome)} + unpacked extension\n`);
  const browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let client: CdpClient | undefined;
  const findings: WalkFinding[] = [];
  try {
    client = await CdpClient.connect(await devtoolsEndpoint(profile, browser));
    for (const url of urls) {
      console.log(`— ${url}`);
      const finding = await walkUrl(client, url);
      findings.push(finding);
      const registry = finding.documentModelContext
        ? finding.registryIsOurShim
          ? 'our shim'
          : 'native or page-supplied'
        : 'absent';
      console.log(
        `   loaded=${finding.loadedWithinDeadline} readyState=${finding.readyState} registry=${registry}` +
          ` shopify=${finding.shopifyMcpEnabled ? 'enabled' : 'no'}/${finding.shopifyAdapterRegistered ? 'registered' : 'not-registered'}` +
          ` tools=${String(finding.toolCount)}${finding.toolNames.length > 0 ? ` [${finding.toolNames.join(', ')}]` : ''}` +
          `${finding.error ? ` ERROR=${finding.error}` : ''}`,
      );
    }
  } finally {
    await client?.close().catch(() => {});
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGTERM');
      const exited = new Promise<boolean>((resolveExit) => browser.once('exit', () => resolveExit(true)));
      if (!(await Promise.race([exited, delay(2_000).then(() => false)]))) browser.kill('SIGKILL');
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  console.log('\nJSON findings:');
  console.log(JSON.stringify(findings, null, 1));
}

await main();
