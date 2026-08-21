/**
 * The wallet's front door — and deliberately almost nothing else.
 *
 * The popup answers one question: *which of my agents are here?* Identity is
 * created silently on first open (there is no decision for the user to make),
 * the relay defaults to the deployed one, and both live behind the gear for
 * the rare day someone self-hosts. The only first-run task is pairing, so
 * that is the only thing a fresh install shows.
 *
 * This page runs on the extension origin. No site script exists in this
 * context, so it is the one place in the extension where nisli's `component()`
 * custom elements are used without the page-world registry caveat; the
 * fallback widget gets the same property from its extension-origin iframe.
 *
 * The secret key is never rendered and never leaves the service worker; the
 * popup only ever sees the public key.
 */

import { component, computed, each, html, signal, when } from '@nisli/core';
import type { AgentRow, PopupToWorker } from './bridge.js';
import { AGENTPORT_VERSION } from './version.js';

const port = chrome.runtime.connect({ name: 'agentport.popup' });
const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

port.onMessage.addListener((raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return;
  const message = raw as { t?: string; rid?: string; value?: unknown; message?: string };
  if (typeof message.rid !== 'string') return;
  const waiter = waiters.get(message.rid);
  waiters.delete(message.rid);
  if (!waiter) return;
  if (message.t === 'ok') waiter.resolve(message.value);
  else waiter.reject(new Error(message.message ?? 'request failed'));
});

function ask<T>(message: PopupToWorker): Promise<T> {
  const rid = `r_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<T>((resolve, reject) => {
    waiters.set(rid, { resolve: resolve as (value: unknown) => void, reject });
    port.postMessage({ ...message, rid });
  });
}

/** One origin holding standing authority over an agent — live, or resumable.
 *  Mirrors `StandingRow` in popup-api.ts, which is the shape's owner. */
interface SessionRow {
  origin: string;
  agent: string;
  agentName: string;
  surface: string;
  live: boolean;
  tools: number;
  gated: number;
  expiresAt: number;
}

const pubkey = signal<string | null>(null);
const relay = signal('');
const agents = signal<AgentRow[]>([]);
const sessions = signal<SessionRow[]>([]);
const status = signal('');
const pairing = signal(false);
const settings = signal(false);
const offer = signal<{ code: string; agent: { name: string; runtime: string; location?: string } } | null>(null);
/** 'legacy' | 'locked' | 'unlocked' | 'none' — rendered, never collapsed. */
const custody = signal('none');
/** Origins the provider exists on, plus this tab's own origin if readable. */
const enabledSites = signal<string[]>([]);
const tabOrigin = signal<string | null>(null);
const tabId = signal<number | null>(null);

async function run(label: string, work: () => Promise<void>): Promise<void> {
  status.value = label;
  try {
    await work();
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

async function refresh(): Promise<void> {
  const [list, live] = await Promise.all([
    ask<{ agents: AgentRow[] }>({ t: 'agents' }),
    ask<{ sessions: SessionRow[] }>({ t: 'sessions' }),
  ]);
  agents.value = list.agents;
  sessions.value = live.sessions;
}

const Agents = component('ap-agents', () => html`
  <section>
    ${each(agents, (agent) => agent.agent, (agent) => {
      const name = computed(() => agent.value.name);
      const line = computed(() => `${agent.value.runtime} · ${agent.value.location ?? 'unknown'}`);
      const dot = computed(() => (agent.value.online ? 'dot on' : 'dot'));
      const state = computed(() => (agent.value.online ? 'online' : 'offline'));
      return html`
        <div class="card row-card">
          <span class=${dot}></span>
          <div class="grow">
            <b>${name}</b>
            <small>${line}</small>
          </div>
          <small class="state">${state}</small>
        </div>`;
    })}
  </section>`);

/**
 * The list ADR-014 called the missing trust surface: what currently holds
 * your agent, and the button that takes it back. Revoking withdraws the
 * origin's WHOLE grant (ADR-022: no per-tool vocabulary exists yet, so all
 * of it is the honest offer) and genuinely ends extension attachments —
 * tombstones are judged per-origin across tiers now. Approving again later
 * works; a revocation is a tombstone, not a denylist.
 */
const Sessions = component('ap-sessions', () => html`
  <section>
    <h2>Origins holding your agent</h2>
    ${each(sessions, (session) => `${session.origin}\n${session.agent}`, (session) => {
      const origin = computed(() => session.value.origin);
      const detail = computed(() => {
        const row = session.value;
        const state = row.live
          ? `${row.tools} tools${row.gated > 0 ? ` (${row.gated} ask every time)` : ''}`
          : 'not attached right now, but may re-attach';
        return `${row.agentName} · ${state} · until ${new Date(row.expiresAt).toLocaleTimeString()}`;
      });
      return html`
        <div class="card row-card">
          <div class="grow"><b>${origin}</b><small>${detail}</small></div>
          <button @click=${() => void run('revoking…', async () => {
            const row = session.value;
            await ask({ t: 'revoke', agent: row.agent, origin: row.origin });
            await refresh();
          })}>Revoke</button>
        </div>`;
    })}
    ${when(computed(() => sessions.value.length > 1), () => html`
      <div class="row">
        <button class="ghost" @click=${() => void run('revoking every origin…', async () => {
          await ask({ t: 'revoke.all' });
          await refresh();
        })}>Revoke all</button>
      </div>`)}
    <p class="hint">Revoking withdraws the whole grant for that origin and ends its attachment now. Approving again later works — nothing is blacklisted.</p>
  </section>`);

const Pairing = component('ap-pairing', () => {
  const code = signal('');
  const firstRun = computed(() => agents.value.length === 0);
  return html`
    <section>
      ${when(firstRun, () => html`
        <p>Your agent runs in a terminal; this extension is only its wallet. To pair the two, once:</p>
        <ol class="steps">
          <li>On your laptop or VPS, run <code>npx @gkoreli/agentport</code>.</li>
          <li>Open the link it prints and approve here.</li>
        </ol>
        <p class="hint">After that, connecting on any site is one tap, and approvals open in a trusted extension window.</p>`)}
      ${when(computed(() => offer.value === null), () => html`
        <div class="row">
          <input
            type="text"
            placeholder="pairing code"
            @input=${(event: Event) => { code.value = (event.target as HTMLInputElement).value; }}
          />
          <button class="primary" @click=${() => void run('looking up…', async () => {
            const claimed = await ask<{ code: string; agent: { name: string; runtime: string; location?: string } }>({
              t: 'pair.claim',
              code: code.value,
            });
            offer.value = claimed;
          })}>Pair</button>
        </div>
        <p class="hint">Pairing links fill this automatically. Manual entry is for moving a code between different devices.</p>`)}
      ${when(computed(() => offer.value !== null), () => {
        const current = offer.value!;
        return html`
          <div class="card">
            <b>${current.agent.name}</b>
            <small>${current.agent.runtime} · ${current.agent.location ?? 'unknown'}</small>
          </div>
          <p class="hint">Pairing signs an ownership certificate with your key. Only this browser will be able to open sessions with this agent.</p>
          <div class="row">
            <button @click=${() => { offer.value = null; pairing.value = false; }}>Cancel</button>
            <button class="primary" @click=${() => void run('signing…', async () => {
              await ask({ t: 'pair.approve', code: current.code });
              offer.value = null;
              pairing.value = false;
              await refresh();
            })}>This is my agent</button>
          </div>`;
      })}
    </section>`;
});

const Settings = component('ap-settings', () => {
  const draft = signal('');
  const short = computed(() => {
    const key = pubkey.value;
    return key ? `${key.slice(0, 10)}…${key.slice(-10)}` : 'creating…';
  });
  return html`
    <section class="settings">
      <h2>Version</h2>
      <p class="mono">${AGENTPORT_VERSION}</p>
      <h2>Your key</h2>
      <p class="mono">${short}</p>
      <h2>Relay</h2>
      <p class="mono">${relay}</p>
      <div class="row">
        <input
          type="text"
          placeholder="wss://…  (self-hosted relay)"
          @input=${(event: Event) => { draft.value = (event.target as HTMLInputElement).value; }}
        />
        <button @click=${() => void run('saving…', async () => {
          if (!draft.value.trim()) return;
          await ask({ t: 'relay.set', url: draft.value.trim() });
          const identity = await ask<{ pubkey?: string; relay: string }>({ t: 'identity' });
          relay.value = identity.relay;
        })}>Save</button>
      </div>
    </section>`;
});

/**
 * Key custody, shown honestly. 'legacy' is not an error state — it is how
 * every pre-wrapping install arrives and how the silent first-run create
 * works — but it is UNPROTECTED at rest and the card says so, with the
 * upgrade beside it. What a passphrase protects (the key at rest: a stolen
 * disk or copied profile) and what it does not (a compromised running
 * browser) is stated in keywrap.ts and must not be oversold here.
 */
const Custody = component('ap-custody', () => {
  const pass = signal('');
  const passField = (placeholder: string) => html`
    <input
      type="password"
      placeholder=${placeholder}
      @input=${(event: Event) => { pass.value = (event.target as HTMLInputElement).value; }}
    />`;
  return html`
    <section>
      ${when(computed(() => custody.value === 'locked'), () => html`
        <div class="card">
          <b>Locked</b>
          <small>Unlock to use your agents in this browser session.</small>
          <div class="row">
            ${passField('passphrase')}
            <button class="primary" @click=${() => void run('unlocking…', async () => {
              const result = await ask<{ custody: string }>({ t: 'identity.unlock', passphrase: pass.value });
              custody.value = result.custody;
              pass.value = '';
              await refresh();
            })}>Unlock</button>
          </div>
        </div>`)}
      ${when(computed(() => custody.value === 'legacy'), () => html`
        <div class="card">
          <b>Key is unprotected at rest</b>
          <small>Set a passphrase to encrypt it on disk. You will unlock once per browser session. This protects a stolen disk or copied profile — not a compromised browser.</small>
          <div class="row">
            ${passField('new passphrase (8+ characters)')}
            <button @click=${() => void run('protecting…', async () => {
              const result = await ask<{ custody: string }>({ t: 'identity.protect', passphrase: pass.value });
              custody.value = result.custody;
              pass.value = '';
            })}>Protect</button>
          </div>
        </div>`)}
    </section>`;
});

/**
 * Where AgentPort exists, per origin. Everything page-visible — the provider,
 * the WebMCP shim, the panel — exists only on origins enabled here; on every
 * other site the extension is unobservable. Enabling registers the provider
 * for the NEXT document, so the button offers the reload rather than
 * pretending a mid-life injection could still catch document_start.
 */
const Sites = component('ap-sites', () => {
  const here = computed(() => tabOrigin.value);
  const hereEnabled = computed(() => here.value !== null && enabledSites.value.includes(here.value));
  const others = computed(() => enabledSites.value.filter((origin) => origin !== tabOrigin.value));
  return html`
    <section>
      <h2>Where AgentPort is on</h2>
      ${when(computed(() => here.value !== null && !hereEnabled.value), () => html`
        <div class="card row-card">
          <div class="grow"><b>${computed(() => here.value ?? '')}</b><small>off — this site cannot see AgentPort</small></div>
          <button class="primary" @click=${() => void run('enabling…', async () => {
            const origin = here.value;
            if (!origin) return;
            const result = await ask<{ origins: string[] }>({ t: 'site.set', origin, enabled: true });
            enabledSites.value = result.origins;
            const tab = tabId.value;
            if (tab !== null) await chrome.tabs.reload(tab);
          })}>Enable + reload</button>
        </div>`)}
      ${when(hereEnabled, () => html`
        <div class="card row-card">
          <div class="grow"><b>${computed(() => here.value ?? '')}</b><small>on — this site can use your agent</small></div>
          <button @click=${() => void run('disabling…', async () => {
            const origin = here.value;
            if (!origin) return;
            const result = await ask<{ origins: string[] }>({ t: 'site.set', origin, enabled: false });
            enabledSites.value = result.origins;
            const tab = tabId.value;
            if (tab !== null) await chrome.tabs.reload(tab);
          })}>Disable</button>
        </div>`)}
      ${each(others, (origin) => origin, (origin) => html`
        <div class="card row-card">
          <div class="grow"><small>${origin}</small></div>
          <button class="ghost" @click=${() => void run('disabling…', async () => {
            const result = await ask<{ origins: string[] }>({ t: 'site.set', origin: origin.value, enabled: false });
            enabledSites.value = result.origins;
          })}>Off</button>
        </div>`)}
    </section>`;
});

const App = component('ap-app', () => {
  const showPairing = computed(() => pairing.value || agents.value.length === 0);
  const haveSessions = computed(() => sessions.value.length > 0);
  const havePaired = computed(() => agents.value.length > 0);
  return html`
    <main>
      <header>
        <b>AgentPort</b>
        <span>${status}</span>
        <button class="icon" title="Settings" @click=${() => { settings.value = !settings.value; }}>⚙</button>
      </header>
      ${Custody({})}
      ${when(computed(() => custody.value !== 'locked'), () => Sites({}))}
      ${when(havePaired, () => Agents({}))}
      ${when(haveSessions, () => Sessions({}))}
      ${when(showPairing, () => Pairing({}))}
      ${when(computed(() => havePaired.value && !showPairing.value), () => html`
        <section class="footer">
          <button class="ghost" @click=${() => { pairing.value = true; }}>+ Pair another agent</button>
        </section>`)}
      ${when(settings, () => Settings({}))}
    </main>`;
});

html`${App({})}`.mount(document.body);

// First open: make the key silently — there is no meaningful choice to offer,
// and every extra step before "pair your agent" is a step people quit on. The
// silent key is the LEGACY (unprotected-at-rest) format, and the custody card
// says so and offers the passphrase upgrade right there — protection is an
// offered step, never a wall in front of pairing.
void run('', async () => {
  const identity = await ask<{ pubkey?: string; relay: string; custody: string }>({ t: 'identity' });
  relay.value = identity.relay;
  custody.value = identity.custody;
  if (!identity.pubkey) {
    const created = await ask<{ pubkey: string }>({ t: 'identity.create' });
    pubkey.value = created.pubkey;
    custody.value = 'legacy';
  } else {
    pubkey.value = identity.pubkey;
  }
  // The current tab's origin, readable because opening this popup IS the
  // activeTab grant. A tab with no readable http(s) URL renders no toggle.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) tabId.value = tab.id;
  if (tab?.url && /^https?:/.test(tab.url)) tabOrigin.value = new URL(tab.url).origin;
  enabledSites.value = (await ask<{ origins: string[] }>({ t: 'sites' })).origins;
  // A locked identity cannot refresh (the wallet cannot dial); the custody
  // card is the whole popup until it is unlocked.
  if (custody.value !== 'locked') await refresh();
});

// Presence changes while the popup is open should show up without a button.
const poll = setInterval(() => {
  if (pubkey.value) void refresh().catch(() => undefined);
}, 3000);
window.addEventListener('unload', () => clearInterval(poll));

export {};
