/**
 * connect.js — the drop-in.
 *
 * A site adds one script tag and gets `AgentPort.connect()`. That's the whole
 * integration, in the same spirit as embedding Stripe/Link: the merchant page
 * renders a component and never touches the sensitive material.
 *
 * The load-bearing property is what this file *cannot* do. It holds an
 * ephemeral keypair minted per page load, so:
 *
 *   - it cannot list the user's agents
 *   - it cannot open a session with any of them
 *   - it cannot approve anything
 *
 * All it can do is publish a request and render the code that carries it to
 * wherever the user's key actually lives. The consent — connection *and* every
 * gated tool call — happens there. The widget renders; it never decides.
 */

import { ResumeError,
  AgentWallet,
  type AgentConnectRequest,
  type AgentProvider,
  type AgentSession,
} from '@agentport/client';
import { generateKeyPair } from '@agentport/protocol';
import { openConnectModal } from './modal.js';
import { createWebMcpHarvester } from './webmcp.js';

function relayUrl(): string {
  const configured = document.currentScript?.getAttribute('data-relay');
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
}

const RELAY = relayUrl();
const webMcp = createWebMcpHarvester({
  document: document as Document & { modelContext?: unknown },
  navigator: navigator as Navigator & { modelContext?: unknown },
});

/**
 * Where a resumable session is remembered.
 *
 * sessionStorage, not localStorage: it is per-tab and dies when the tab
 * closes, which matches what the token grants — re-attaching to a session the
 * user already approved, whose grant still expires on its own schedule. It is
 * deliberately NOT the "remember my agents across sites" feature; that needs a
 * persistent identity and its own opt-in.
 */
const RESUME_KEY = 'agentport.session';

/**
 * Keyed per surface: a tab that moves between two surfaces of one site (or a
 * user who bounces between demo pages) holds one resumable session per
 * surface, instead of each connect overwriting the last one.
 */
function resumeKeyFor(surface: string): string {
  return `${RESUME_KEY}:${surface}`;
}

interface ResumeRecord {
  id: string;
  token: string;
  relay: string;
  surface: string;
  /** The session was sealed; refuse to resume it as plaintext. */
  sealed?: boolean;
}

function rememberSession(record: ResumeRecord): void {
  try {
    sessionStorage.setItem(resumeKeyFor(record.surface), JSON.stringify(record));
  } catch (err) {
    console.warn('[agentport] could not persist session for resume', err);
  }
}

function forgetSession(surface: string): void {
  try {
    sessionStorage.removeItem(resumeKeyFor(surface));
  } catch {
    // storage disabled; resume simply will not be offered
  }
}

function rememberedSession(surface: string): ResumeRecord | null {
  try {
    const raw = sessionStorage.getItem(resumeKeyFor(surface));
    if (!raw) return null;
    const record = JSON.parse(raw) as ResumeRecord;
    if (record.relay !== RELAY || record.surface !== surface) return null;
    return record;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

const provider: AgentProvider & {
  resume(request: AgentConnectRequest): Promise<{ session: AgentSession; missed: number } | null>;
} = {
  version: '0.0.1',

  // Never dials the relay: a page must not be able to learn anything about
  // the user before they have agreed to anything.
  async isAvailable() {
    return true;
  },

  /**
   * Re-attach after a page refresh, if this tab left a live session behind.
   * Returns null when there is nothing to resume — the caller then shows the
   * normal Connect button, so a dead token is never a dead end.
   */
  async resume(request: AgentConnectRequest): Promise<{ session: AgentSession; missed: number } | null> {
    const record = rememberedSession(request.name);
    if (!record) return null;
    const tools = webMcp.harvest(request.tools);

    const wallet = new AgentWallet({ relayUrl: RELAY, userSecretKey: generateKeyPair().secretKey });
    try {
      await wallet.connect();
      const resumed = await wallet.resumeSession({
        id: record.id,
        token: record.token,
        tools,
        decide: () => true,
        requireSealed: record.sealed,
      });
      resumed.session.on('closed', () => forgetSession(request.name));
      return resumed;
    } catch (err) {
      wallet.close();
      // Only a denial that PROVES the session is dead may delete the record.
      // Anything transient — a lost already_attached race, a rekey timeout, a
      // network blip — keeps the token so the next load can try again;
      // deleting it here is how a one-second race used to become a
      // permanently lost session.
      const reason = err instanceof ResumeError ? err.reason : '';
      if (reason === 'not_resumable' || reason === 'grant_expired') {
        console.info(`[agentport] previous session is gone (${reason}), starting fresh`);
        forgetSession(request.name);
        return null;
      }
      console.error('[agentport] resume failed (record kept for retry)', err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  },

  async connect(request: AgentConnectRequest): Promise<AgentSession> {
    const tools = webMcp.harvest(request.tools);
    // Open first, so every later failure is visible to the user.
    const modal = openConnectModal(request.name);

    const wallet = new AgentWallet({
      relayUrl: RELAY,
      // Ephemeral and authority-free. Discarded when the tab goes away.
      userSecretKey: generateKeyPair().secretKey,
    });
    try {
      await wallet.connect();
    } catch (err) {
      console.error('[agentport] relay unreachable', err);
      modal.status(`could not reach the relay: ${(err as Error).message ?? err}`, true);
      throw err;
    }

    const { code, accepted } = await wallet.beginConnect({
      surface: { name: request.name, route: request.route, context: request.context },
      tools,
      alwaysAsk: request.alwaysAsk,
      ttlMs: request.ttlMs,
      // The owner already gated every `requiresApproval` tool before the call
      // reached us — re-asking here would be asking the requester.
      decide: () => true,
    });

    modal.setCode(code);
    try {
      const session = await Promise.race([accepted, modal.cancelled]);
      const token = wallet.resumeTokenFor(session.id);
      if (token) {
        rememberSession({
          id: session.id,
          token,
          relay: RELAY,
          surface: request.name,
          sealed: Boolean(session.info.verify),
        });
      }
      session.on('closed', () => forgetSession(request.name));
      modal.status('connected');
      setTimeout(() => modal.close(), 400);
      return session;
    } catch (err) {
      if (!/cancelled/i.test((err as Error).message)) console.error('[agentport] connect failed', err);
      modal.status((err as Error).message, true);
      setTimeout(() => modal.close(), 2200);
      wallet.close();
      throw err;
    }
  },
};

/**
 * Provider discovery. An installed wallet wins — it can show the picker and
 * the consent screen in browser chrome, which is strictly better than carrying
 * a code by hand. The drop-in is what makes the site work for everyone else.
 */
export function getProvider(): AgentProvider {
  return (navigator as unknown as { agent?: AgentProvider }).agent ?? provider;
}

type InstalledProvider = AgentProvider & {
  resume?: (request: AgentConnectRequest) => Promise<AgentSession | null>;
};

/**
 * An extension injects its provider with an async <script>, so at module time
 * `navigator.agent` may simply not exist YET — deciding on a single synchronous
 * read is how a refresh lands on the drop-in path and shows Connect for a
 * session the wallet still holds. Wait for `agent#initialized` (the NIP-07
 * idiom) with a short deadline before concluding no wallet is installed.
 */
function installedProvider(timeoutMs = 400): Promise<InstalledProvider | undefined> {
  const read = () => (navigator as unknown as { agent?: InstalledProvider }).agent;
  const now = read();
  if (now) return Promise.resolve(now);
  // An extension injects at document_start; once the document has fully
  // loaded, a provider that hasn't appeared never will — don't tax the
  // no-extension path with the deadline.
  if (document.readyState === 'complete') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('agent#initialized', onReady);
      resolve(read());
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      window.removeEventListener('agent#initialized', onReady);
      resolve(read());
    };
    window.addEventListener('agent#initialized', onReady);
  });
}

const AgentPort = {
  provider,
  getProvider,
  connect: async (request: AgentConnectRequest) => {
    const installed = await installedProvider();
    return (installed ?? provider).connect(request);
  },
  /**
   * Resume follows the same discovery as connect: an installed wallet keeps
   * sessions alive across navigations and hands the reclaimed one back; the
   * drop-in falls back to its per-tab sessionStorage token.
   */
  resume: async (request: AgentConnectRequest) => {
    const installed = await installedProvider();
    if (installed?.resume) {
      const session = await installed.resume(request);
      return session ? { session, missed: 0 } : null;
    }
    return provider.resume(request);
  },
};

(globalThis as unknown as { AgentPort: typeof AgentPort }).AgentPort = AgentPort;

export default AgentPort;
export type { AgentConnectRequest, AgentSession };
