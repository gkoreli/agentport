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
 * custom elements are used without the registry caveat that applies inside a
 * page (see the header of overlay.ts).
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

interface SessionRow {
  ref: string;
  origin: string;
  from: string;
  agentName: string;
  tools: string[];
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

const Sessions = component('ap-sessions', () => html`
  <section>
    <h2>In use right now</h2>
    ${each(sessions, (session) => session.ref, (session) => {
      const origin = computed(() => session.value.origin);
      const detail = computed(() => `${session.value.agentName} · ${session.value.tools.length} tools`);
      return html`<div class="card"><b>${origin}</b><small>${detail}</small></div>`;
    })}
  </section>`);

const Pairing = component('ap-pairing', () => {
  const code = signal('');
  const firstRun = computed(() => agents.value.length === 0);
  return html`
    <section>
      ${when(firstRun, () => html`
        <p>Your agent runs in a terminal; this extension is only its wallet. To pair the two, once:</p>
        <ol class="steps">
          <li>In a terminal (laptop or server), run <code>npx agentport</code> and leave it running.</li>
          <li>It prints a short pairing code — paste it below.</li>
        </ol>
        <p class="hint">After that, connecting on any site is one tap, and approvals appear where the agent runs.</p>`)}
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
        <p class="hint">The code is printed where your agent runs — <code>npx agentport</code> on your server.</p>`)}
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
// and every extra step before "pair your agent" is a step people quit on.
void run('', async () => {
  const identity = await ask<{ pubkey?: string; relay: string }>({ t: 'identity' });
  relay.value = identity.relay;
  if (!identity.pubkey) {
    const created = await ask<{ pubkey: string }>({ t: 'identity.create' });
    pubkey.value = created.pubkey;
  } else {
    pubkey.value = identity.pubkey;
  }
  await refresh();
});

// Presence changes while the popup is open should show up without a button.
const poll = setInterval(() => {
  if (pubkey.value) void refresh().catch(() => undefined);
}, 3000);
window.addEventListener('unload', () => clearInterval(poll));

export {};
