/**
 * Real-Chrome regression for the extension-owned iframe overlay.
 *
 * happy-dom cannot model Chrome extension worlds, closed-shadow browsing
 * contexts, or extension registries. This script builds the unpacked extension,
 * loads it into Chrome, and drives both the hostile page and extension iframe
 * over the Chrome DevTools Protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION = join(ROOT, 'packages/extension/dist');
const TIMEOUT_MS = 20_000;

type JsonObject = Record<string, unknown>;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { code: number; message: string };
  sessionId?: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface SessionTarget {
  sessionId: string;
  info: TargetInfo;
}

class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
  }>();
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
        if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
    socket.on('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('Chrome DevTools connection closed'));
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

  /** Bounded on purpose: a CDP call that never answers must fail the run, not
   *  hang it — `waitFor` only re-checks its deadline between attempts. */
  send(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    const id = ++this.#nextId;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        rejectResult(new Error(`CDP ${method} did not answer within ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectResult(error);
        },
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

function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    const suffix = detail === undefined ? '' : `: ${JSON.stringify(detail)}`;
    throw new Error(`${label}${suffix}`);
  }
  console.log(`  ok  ${label}`);
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

async function walkForChrome(root: string): Promise<string | undefined> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
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
          // Keep looking for an executable CfT binary.
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
    'Set AGENTPORT_CHROME to a Chrome/Chrome-for-Testing executable, or unpack Chrome for Testing under /tmp/agentport-cft',
  );
}

const HOSTILE_TAGS = [
  'ui-chat',
  'ui-chat-composer',
  'ui-chat-content',
  'ui-chat-generation-controls',
  'ui-chat-message',
  'ui-chat-reasoning',
  'ui-chat-suggestions',
  'ui-chat-tool-call',
  'ui-chat-transcript',
  'ui-message-scroller',
  'ui-message-scroller-button',
  'ui-message-scroller-content',
  'ui-message-scroller-viewport',
  'ui-message',
  'ui-bubble',
  'ui-bubble-content',
];

function hostilePage(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Hostile extension UI test</title></head>
  <body>
    <h1>Host page</h1>
    <script>
      window.__hostileUpgrades = 0;
      window.__hostileAttachShadowCalls = 0;
      for (const tag of ${JSON.stringify(HOSTILE_TAGS)}) {
        customElements.define(tag, class extends HTMLElement {
          connectedCallback() { window.__hostileUpgrades += 1; }
        });
      }
      const nativeAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(init) {
        window.__hostileAttachShadowCalls += 1;
        return nativeAttachShadow.call(this, init);
      };
    </script>
  </body>
</html>`;
}

async function serveHostilePage(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(hostilePage());
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections();
  });
}

async function waitFor<T>(label: string, read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`);
}

async function devtoolsEndpoint(profile: string, child: ChildProcess): Promise<string> {
  const file = join(profile, 'DevToolsActivePort');
  return waitFor('Chrome DevTools endpoint', async () => {
    if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode}`);
    const contents = await readFile(file, 'utf8').catch(() => '');
    const [port, path] = contents.trim().split(/\r?\n/);
    if (!port || !path) return undefined;
    return `ws://127.0.0.1:${port}${path}`;
  });
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true)));
  if (await Promise.race([exited, delay(2_000).then(() => false)])) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
}

function targetInfo(value: unknown): TargetInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as JsonObject;
  if (
    typeof raw['targetId'] !== 'string' ||
    typeof raw['type'] !== 'string' ||
    typeof raw['title'] !== 'string' ||
    typeof raw['url'] !== 'string'
  ) return undefined;
  return {
    targetId: raw['targetId'],
    type: raw['type'],
    title: raw['title'],
    url: raw['url'],
  };
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

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string, userGesture = false): Promise<T> {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  }, sessionId);
  return remoteValue(response) as T;
}

async function main(): Promise<void> {
  console.log('Building unpacked extension');
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:extension']);
  for (const file of ['manifest.json', 'content.js', 'overlay.html', 'overlay.js']) {
    await access(join(EXTENSION, file));
  }

  const chrome = await chromeExecutable();
  const temporary = await mkdtemp(join(tmpdir(), 'agentport-extension-ui-'));
  const profile = join(temporary, 'profile');
  const { server, origin } = await serveHostilePage();
  // A second loopback port is a second origin: the extension's cross-origin
  // rules must be exercised against a real browser-stamped origin change.
  const { server: otherServer, origin: otherOrigin } = await serveHostilePage();
  const url = `${origin}/hostile`;
  const stderr: string[] = [];
  let browser: ChildProcess | undefined;
  let client: CdpClient | undefined;

  try {
    console.log(`Launching ${basename(chrome)}`);
    const args = [
      '--headless=new',
      '--disable-background-networking',
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
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
    browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr?.setEncoding('utf8');
    browser.stderr?.on('data', (chunk: string) => stderr.push(chunk));

    client = await CdpClient.connect(await devtoolsEndpoint(profile, browser));

    const sessions = new Map<string, SessionTarget>();
    const setup = new Set<Promise<void>>();
    const runtimeErrors: string[] = [];

    const prepare = (sessionId: string, info: TargetInfo): void => {
      sessions.set(sessionId, { sessionId, info });
      const work = (async () => {
        // Queue the domain enables ahead of the resume so no early event is
        // missed, but do NOT await their replies first: a target paused at
        // start (the extension service worker, which now restarts on every
        // navigation) answers them only once it is running, and awaiting them
        // before `runIfWaitingForDebugger` deadlocks the whole run.
        const enabled = Promise.all([
          client?.send('Runtime.enable', {}, sessionId),
          client?.send('Log.enable', {}, sessionId),
          ...(info.type === 'page' || info.type === 'iframe'
            ? [client?.send('Target.setAutoAttach', {
                autoAttach: true,
                waitForDebuggerOnStart: true,
                flatten: true,
              }, sessionId)]
            : []),
        ]);
        // If the resume below fails first, these replies would reject with
        // nobody listening and take the process down on an unhandled
        // rejection. The real failure is reported through `work`.
        enabled.catch(() => undefined);
        await client?.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        await enabled;
      })().catch((error: unknown) => {
        throw new Error(`could not prepare ${info.type} target ${info.url}: ${String(error)}`);
      });
      setup.add(work);
      void work.finally(() => setup.delete(work));
    };

    client.onEvent((message) => {
      if (message.method === 'Target.attachedToTarget') {
        const sessionId = message.params?.['sessionId'];
        const info = targetInfo(message.params?.['targetInfo']);
        if (typeof sessionId === 'string' && info) prepare(sessionId, info);
        return;
      }
      if (message.method === 'Target.targetInfoChanged') {
        const info = targetInfo(message.params?.['targetInfo']);
        if (!info) return;
        for (const target of sessions.values()) {
          if (target.info.targetId === info.targetId) target.info = info;
        }
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.['exceptionDetails'] as JsonObject | undefined;
        runtimeErrors.push(`exception: ${String(details?.['text'] ?? 'unknown')}`);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = message.params?.['type'];
        if (type !== 'error' && type !== 'assert') return;
        const args = Array.isArray(message.params?.['args']) ? message.params?.['args'] as JsonObject[] : [];
        runtimeErrors.push(`console.${type}: ${args.map((arg) => String(arg['value'] ?? arg['description'] ?? '')).join(' ')}`);
        return;
      }
      if (message.method === 'Log.entryAdded') {
        const entry = message.params?.['entry'] as JsonObject | undefined;
        if (entry?.['level'] === 'error') runtimeErrors.push(`log: ${String(entry['text'] ?? 'unknown')}`);
      }
    });

    await client.send('Target.setDiscoverTargets', { discover: true });
    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    const created = await client.send('Target.createTarget', { url: 'about:blank' });
    const pageTargetId = created['targetId'];
    if (typeof pageTargetId !== 'string') throw new Error('Chrome did not return a page target id');

    let page = await waitFor('auto-attached host page', () =>
      [...sessions.values()].find((target) => target.info.targetId === pageTargetId));
    await Promise.all([...setup]);
    await client.send('Page.enable', {}, page.sessionId);
    await client.send('Page.navigate', { url }, page.sessionId);

    page = await waitFor('hostile page navigation', () => {
      const target = [...sessions.values()].find((candidate) => candidate.info.targetId === pageTargetId);
      return target?.info.url === url ? target : undefined;
    });

    const frame = await waitFor('extension overlay iframe', () =>
      [...sessions.values()].find((target) =>
        target.info.type === 'iframe' && /^chrome-extension:\/\/[^/]+\/overlay\.html#/.test(target.info.url)));
    await Promise.all([...setup]);

    const boundary = await waitFor<JsonObject>('closed overlay host', async () => {
      const value = await evaluate<JsonObject | undefined>(client!, page.sessionId, `(() => {
        const host = document.querySelector('[data-agentport-ui]');
        if (!host) return undefined;
        const indexedFrames = [];
        for (let index = 0; index < window.length; index += 1) indexedFrames.push(typeof window[index]);
        return {
          hostCount: document.querySelectorAll('[data-agentport-ui]').length,
          shadowRoot: host.shadowRoot,
          visibleIframes: document.querySelectorAll('iframe').length,
          frameCount: window.length,
          indexedFrames,
          hostileUpgrades: window.__hostileUpgrades,
          hostileAttachShadowCalls: window.__hostileAttachShadowCalls,
        };
      })()`);
      return value;
    });
    check('one extension host is present', boundary['hostCount'] === 1, boundary);
    check('host exposes no shadow root', boundary['shadowRoot'] === null, boundary);
    check('page selectors cannot enumerate the iframe', boundary['visibleIframes'] === 0, boundary);
    check('window.frames cannot enumerate the iframe', boundary['frameCount'] === 0, boundary);
    check('hostile custom elements never upgraded', boundary['hostileUpgrades'] === 0, boundary);
    check('host page attachShadow patch was bypassed by the isolated world', boundary['hostileAttachShadowCalls'] === 0, boundary);

    const clicked = await waitFor('extension FAB', async () => {
      const didClick = await evaluate<boolean>(client!, frame.sessionId, `(() => {
        const button = document.querySelector('button.fab');
        if (!button) return false;
        button.click();
        return true;
      })()`, true);
      return didClick ? true : undefined;
    });
    check('FAB clicked through the extension iframe target', clicked === true);

    const rendered = await waitFor<JsonObject>('shared Chat renderer', async () => {
      const value = await evaluate<JsonObject | undefined>(client!, frame.sessionId, `(() => {
        const chat = document.querySelector('ui-chat');
        const panel = document.querySelector('.panel');
        const fab = document.querySelector('button.fab');
        if (!chat || !panel || !fab || innerWidth <= 80 || innerHeight <= 80) return undefined;
        const panelRect = panel.getBoundingClientRect();
        const fabRect = fab.getBoundingClientRect();
        const slots = [
          'chat',
          'message-scroller',
          'message-scroller-viewport',
          'chat-transcript',
          'chat-composer',
          'chat-composer-input',
        ];
        return {
          chatTag: chat.tagName,
          layout: {
            panelTop: panelRect.top,
            panelBottom: panelRect.bottom,
            panelLeft: panelRect.left,
            panelRight: panelRect.right,
            fabTop: fabRect.top,
            fabBottom: fabRect.bottom,
            fabRight: fabRect.right,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
          },
          slots: Object.fromEntries(slots.map((slot) => [slot, Boolean(document.querySelector('[data-slot="' + slot + '"]'))])),
          panelText: panel.textContent,
        };
      })()`);
      return value;
    });
    check('UI-CHAT is instantiated in extension origin', rendered['chatTag'] === 'UI-CHAT', rendered);
    const slots = rendered['slots'] as JsonObject;
    for (const slot of ['chat', 'message-scroller', 'message-scroller-viewport', 'chat-transcript', 'chat-composer', 'chat-composer-input']) {
      check(`semantic slot ${slot} rendered`, slots[slot] === true, rendered);
    }
    const layout = rendered['layout'] as JsonObject;
    check('panel and FAB do not overlap', Number(layout['panelBottom']) <= Number(layout['fabTop']) - 12, layout);
    check('FAB uses the iframe inset on the right', Number(layout['viewportWidth']) - Number(layout['fabRight']) === 18, layout);
    check('FAB uses the iframe inset on the bottom', Number(layout['viewportHeight']) - Number(layout['fabBottom']) === 18, layout);
    check('panel uses the iframe inset', Number(layout['panelTop']) === 18 && Number(layout['panelLeft']) === 18 && Number(layout['viewportWidth']) - Number(layout['panelRight']) === 18, layout);
    check('idle attachment surface rendered', String(rendered['panelText']).includes('Attach your agent'), rendered);

    // --- navigation ------------------------------------------------------
    //
    // The widget now reclaims its attachment at document_start on every
    // top-level page, and that same port is what tells the worker which origin
    // the tab is on. This harness has no relay, daemon or paired agent, so it
    // cannot hold a live attachment across the navigation; what it CAN prove is
    // that the new document_start path runs on a real page without error and
    // that the extension re-establishes its own isolated surface afterwards —
    // including on a document whose origin the tab never approved.
    const seenOverlayTargets = new Set<string>([frame.info.targetId]);

    const navigate = async (label: string, destination: string): Promise<void> => {
      await client!.send('Page.navigate', { url: destination }, page.sessionId);
      page = await waitFor(`${label} navigation`, () => {
        const target = [...sessions.values()].find((candidate) => candidate.info.targetId === pageTargetId);
        return target?.info.url === destination ? target : undefined;
      });
      const next = await waitFor(`${label} overlay iframe`, () =>
        [...sessions.values()].find((target) =>
          target.info.type === 'iframe'
          && /^chrome-extension:\/\/[^/]+\/overlay\.html#/.test(target.info.url)
          && !seenOverlayTargets.has(target.info.targetId)));
      seenOverlayTargets.add(next.info.targetId);
      await Promise.all([...setup]);

      const isolation = await waitFor<JsonObject>(`${label} isolation`, async () => {
        const value = await evaluate<JsonObject | undefined>(client!, page.sessionId, `(() => {
          const host = document.querySelector('[data-agentport-ui]');
          if (!host) return undefined;
          return {
            hostCount: document.querySelectorAll('[data-agentport-ui]').length,
            shadowRoot: host.shadowRoot,
            visibleIframes: document.querySelectorAll('iframe').length,
            frameCount: window.length,
          };
        })()`);
        return value;
      });
      check(`${label}: one extension host after navigation`, isolation['hostCount'] === 1, isolation);
      check(`${label}: host still exposes no shadow root`, isolation['shadowRoot'] === null, isolation);
      check(`${label}: page still cannot enumerate the iframe`, isolation['visibleIframes'] === 0, isolation);
      check(`${label}: window.frames still cannot enumerate the iframe`, isolation['frameCount'] === 0, isolation);

      await waitFor(`${label} FAB`, async () => {
        const didClick = await evaluate<boolean>(client!, next.sessionId, `(() => {
          const button = document.querySelector('button.fab');
          if (!button) return false;
          button.click();
          return true;
        })()`, true);
        return didClick ? true : undefined;
      });
      const panelText = await waitFor<string>(`${label} panel`, async () => {
        const value = await evaluate<string | undefined>(client!, next.sessionId, `(() => {
          const panel = document.querySelector('.panel');
          return panel ? panel.textContent : undefined;
        })()`);
        return value === undefined || value === '' ? undefined : value;
      });
      // No agent is paired in this profile, so the only correct outcome is the
      // idle attach surface: a hung reclaim or a session handed to this
      // document would render something else.
      check(`${label}: idle attachment surface rendered`, panelText.includes('Attach your agent'), panelText);
    };

    await navigate('same-origin navigation', `${origin}/second`);
    await navigate('cross-origin navigation', `${otherOrigin}/hostile`);

    await delay(100);
    await Promise.all([...setup]);
    check('no runtime, console, or browser log errors', runtimeErrors.length === 0, runtimeErrors);
    check('Chrome remained alive', browser.exitCode === null, { exitCode: browser.exitCode, signal: browser.signalCode });
    console.log('Extension UI smoke passed');
  } catch (error) {
    if (stderr.length > 0) console.error(`Chrome stderr:\n${stderr.join('').slice(-8_000)}`);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    if (browser) await stopChrome(browser);
    await closeServer(server).catch(() => undefined);
    await closeServer(otherServer).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
