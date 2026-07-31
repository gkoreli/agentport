/**
 * The wallet's front door: identity, relay, pairing, and what is currently
 * attached to what.
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

async function loadIdentity(): Promise<void> {
  const identity = await ask<{ pubkey?: string; relay: string }>({ t: 'identity' });
  pubkey.value = identity.pubkey ?? null;
  relay.value = identity.relay;
}

async function refresh(): Promise<void> {
  const [list, live] = await Promise.all([
    ask<{ agents: AgentRow[] }>({ t: 'agents' }),
    ask<{ sessions: SessionRow[] }>({ t: 'sessions' }),
  ]);
  agents.value = list.agents;
  sessions.value = live.sessions;
}

const Identity = component('ap-identity', () => {
  const short = computed(() => {
    const key = pubkey.value;
    return key ? `${key.slice(0, 8)}…${key.slice(-8)}` : 'no identity yet';
  });
  return html`
    <section>
      <h2>Identity</h2>
      <p class="mono">${short}</p>
      ${when(computed(() => pubkey.value === null), () => html`
        <button
          class="primary"
          @click=${() => void run('creating…', async () => { await ask({ t: 'identity.create' }); await loadIdentity(); })}
        >Create a user key</button>
        <p class="hint">Stored in extension storage. Never reachable from a page.</p>`)}
    </section>`;
});

const Relay = component('ap-relay', () => {
  const draft = signal('');
  return html`
    <section>
      <h2>Relay</h2>
      <p class="mono">${relay}</p>
      <div class="row">
        <input
          type="text"
          placeholder="ws://127.0.0.1:8787"
          @input=${(event: Event) => { draft.value = (event.target as HTMLInputElement).value; }}
        />
        <button @click=${() => void run('saving…', async () => {
          if (!draft.value.trim()) return;
          await ask({ t: 'relay.set', url: draft.value.trim() });
          await loadIdentity();
        })}>Save</button>
      </div>
    </section>`;
});

const Pairing = component('ap-pairing', () => {
  const code = signal('');
  return html`
    <section>
      <h2>Pair an agent</h2>
      ${when(computed(() => offer.value === null), () => html`
        <div class="row">
          <input
            type="text"
            placeholder="PAIR-CODE"
            @input=${(event: Event) => { code.value = (event.target as HTMLInputElement).value; }}
          />
          <button @click=${() => void run('claiming…', async () => {
            const claimed = await ask<{ code: string; agent: { name: string; runtime: string; location?: string } }>({
              t: 'pair.claim',
              code: code.value,
            });
            offer.value = claimed;
          })}>Claim</button>
        </div>
        <p class="hint">Run <code>npm run daemon</code> and paste the code it prints.</p>`)}
      ${when(computed(() => offer.value !== null), () => {
        const current = offer.value!;
        return html`
          <p><b>${current.agent.name}</b><br /><small>${current.agent.runtime} · ${current.agent.location ?? 'unknown'}</small></p>
          <p class="hint">Approving signs an ownership certificate with your user key.</p>
          <div class="row">
            <button @click=${() => { offer.value = null; }}>Cancel</button>
            <button class="primary" @click=${() => void run('signing…', async () => {
              await ask({ t: 'pair.approve', code: current.code });
              offer.value = null;
              await refresh();
            })}>Approve &amp; sign</button>
          </div>`;
      })}
    </section>`;
});

const Agents = component('ap-agents', () => html`
  <section>
    <div class="head">
      <h2>Agents</h2>
      <button @click=${() => void run('loading…', refresh)}>Refresh</button>
    </div>
    ${when(computed(() => agents.value.length === 0), () => html`<p class="hint">None paired yet.</p>`)}
    ${each(agents, (agent) => agent.agent, (agent) => {
      const line = computed(() => `${agent.value.runtime} · ${agent.value.location ?? 'unknown'}`);
      const state = computed(() => (agent.value.online ? 'online' : 'offline'));
      return html`
        <div class="card">
          <b>${computed(() => agent.value.name)}</b>
          <small>${line} · ${state}</small>
        </div>`;
    })}
  </section>`);

const Sessions = component('ap-sessions', () => html`
  <section>
    <h2>Attached right now</h2>
    ${when(computed(() => sessions.value.length === 0), () => html`<p class="hint">Nothing attached.</p>`)}
    ${each(sessions, (session) => session.ref, (session) => {
      const origin = computed(() => session.value.origin);
      const detail = computed(() => `${session.value.agentName} · ${session.value.from} · ${session.value.tools.length} tools`);
      return html`<div class="card"><b>${origin}</b><small>${detail}</small></div>`;
    })}
  </section>`);

const App = component('ap-app', () => html`
  <main>
    <header><b>AgentPort</b><span>${status}</span></header>
    ${Identity({})}
    ${Relay({})}
    ${Pairing({})}
    ${Agents({})}
    ${Sessions({})}
  </main>`);

html`${App({})}`.mount(document.body);

void run('loading…', async () => {
  await loadIdentity();
  if (pubkey.value) await refresh();
});

export {};
