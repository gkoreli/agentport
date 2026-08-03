/**
 * The consent window — extension chrome, not page DOM (ADR-009).
 *
 * Opened by the service worker via `chrome.windows.create` for two questions:
 * a connection request (pick an agent, review the tools, Approve/Decline) and
 * every per-call approval. A site can neither draw this window nor read it nor
 * click into it; the origin it displays is Chrome's own view of the asking
 * frame (`port.sender`), never anything the page said about itself.
 *
 * The question is fetched by id, answered once over the port, and a closed
 * window is a denial. Real agent names render here and only here.
 */

import { component, computed, each, html, signal, when } from '@nisli/core';
import { randomId } from '@agentport/protocol';
import type { AgentRow, ConsentPayload, ConsentToWorker } from './bridge.js';

const port = chrome.runtime.connect({ name: 'agentport.consent' });
const questionId = location.hash.slice(1);

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

function ask<T>(message: Extract<ConsentToWorker, { rid: string }>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiters.set(message.rid, { resolve: resolve as (value: unknown) => void, reject });
    port.postMessage(message);
  });
}

let answered = false;
function answer(value: unknown): void {
  if (answered) return;
  answered = true;
  port.postMessage({ t: 'consent.answer', id: questionId, value } satisfies ConsentToWorker);
  window.close();
}

const payload = signal<ConsentPayload | null>(null);
const error = signal('');
const selected = signal<string | null>(null);

const Connect = component('ap-consent-connect', () => {
  const state = payload.value as Extract<ConsentPayload, { kind: 'connect' }>;
  const agents = signal<AgentRow[]>(state.agents);
  const gatedNames = new Set(state.request.alwaysAsk ?? []);
  const free = state.request.tools.filter((tool) => !gatedNames.has(tool.name) && !tool.requiresApproval);
  const gated = state.request.tools.filter((tool) => gatedNames.has(tool.name) || tool.requiresApproval);
  // One online agent means there is nothing to pick; preselect it so the whole
  // flow is literally one tap on Approve.
  const online = state.agents.filter((agent) => agent.online);
  if (online.length === 1 && online[0]) selected.value = online[0].agent;
  const canApprove = computed(() => selected.value !== null);
  return html`
    <main>
      <header><b>AgentPort</b><span>connection request</span></header>
      <section>
        <div class="origin">
          <b>${state.origin}</b>
          <small>Verified origin — reported by the browser, not by the page.</small>
        </div>
        <p class="surface">“${state.request.name}” wants to lend tools to one of your agents.</p>
      </section>
      <section>
        <h2>Your agents</h2>
        ${each(agents, (agent) => agent.agent, (agent) => {
          const chosen = computed(() => (selected.value === agent.value.agent ? 'true' : 'false'));
          const line = computed(() => `${agent.value.runtime} · ${agent.value.location ?? 'unknown'} · ${agent.value.online ? 'Online' : 'Offline'}`);
          const name = computed(() => agent.value.name);
          const dot = computed(() => (agent.value.online ? 'dot on' : 'dot'));
          return html`
            <button
              class="agent"
              type="button"
              aria-selected=${chosen}
              disabled=${!agent.value.online}
              @click=${() => { selected.value = agent.value.agent; }}
            >
              <span class=${dot}></span>
              <span class="grow"><b>${name}</b><small>${line}</small></span>
            </button>`;
        })}
      </section>
      <section>
        <h2>Allowed for this session</h2>
        <ul>${free.length ? free.map((tool) => html`<li>${tool.description}</li>`) : html`<li>—</li>`}</ul>
        <h2>Asks every time</h2>
        <ul>${gated.length ? gated.map((tool) => html`<li class="ask">${tool.description}</li>`) : html`<li>—</li>`}</ul>
        <p class="hint">The site will see a generic “Personal agent” label, never your agent's real name.</p>
      </section>
      <footer>
        <button type="button" @click=${() => answer(null)}>Decline</button>
        <button class="primary" type="button" disabled=${computed(() => !canApprove.value)}
          @click=${() => { if (selected.value) answer(selected.value); }}>Approve</button>
      </footer>
    </main>`;
});

const Approve = component('ap-consent-approve', () => {
  const state = payload.value as Extract<ConsentPayload, { kind: 'approve' }>;
  let args = '';
  if (state.call) {
    try {
      args = JSON.stringify(state.call.arguments, null, 2);
    } catch {
      args = '';
    }
  }
  return html`
    <main>
      <header><b>AgentPort</b><span>approval</span></header>
      <section>
        <div class="origin">
          <b>${state.origin}</b>
          <small>Verified origin — reported by the browser, not by the page.</small>
        </div>
        <p class="surface">${state.agentName} asks: ${state.summary}</p>
        ${when(computed(() => Boolean(args)), () => html`<pre>${args}</pre>`)}
      </section>
      <footer>
        <button type="button" @click=${() => answer(false)}>Decline</button>
        <button class="primary" type="button" @click=${() => answer(true)}>Approve</button>
      </footer>
    </main>`;
});

const Pair = component('ap-consent-pair', () => {
  const state = payload.value as Extract<ConsentPayload, { kind: 'pair' }>;
  return html`
    <main>
      <header><b>AgentPort</b><span>pair agent</span></header>
      <section>
        <p class="surface">Add this agent to your wallet?</p>
        <div class="card">
          <b>${state.agent.name}</b>
          <small>${state.agent.runtime} · ${state.agent.location ?? 'unknown location'}</small>
        </div>
        <p class="hint">Pairing signs an ownership certificate inside this extension. The agent's device key stays on its machine, and your wallet key never leaves Chrome.</p>
      </section>
      <footer>
        <button type="button" @click=${() => answer(false)}>Decline</button>
        <button class="primary" type="button" @click=${() => answer(true)}>Pair agent</button>
      </footer>
    </main>`;
});

const App = component('ap-consent', () => {
  const view = computed(() => {
    if (error.value) return html`<main><section><p class="hint">${error.value}</p></section></main>`;
    const current = payload.value;
    if (!current) return html`<main><section><p class="hint">Loading…</p></section></main>`;
    if (current.kind === 'connect') return Connect({});
    if (current.kind === 'pair') return Pair({});
    return Approve({});
  });
  return html`${view}`;
});

html`${App({})}`.mount(document.body);

// Escape always means "no" — the same stance as everywhere else: a missing
// answer is a denial, never a default grant.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') answer(payload.value?.kind === 'connect' ? null : false);
});
// The worker also treats window-close as a denial; answering here as well just
// makes the denial immediate instead of waiting for onRemoved.
window.addEventListener('pagehide', () => {
  if (!answered) {
    answered = true;
    port.postMessage({ t: 'consent.answer', id: questionId, value: payload.value?.kind === 'connect' ? null : false } satisfies ConsentToWorker);
  }
});

void ask<ConsentPayload>({ t: 'consent.get', rid: randomId('r_'), id: questionId }).then(
  (value) => {
    payload.value = value;
  },
  (err: Error) => {
    error.value = err.message;
  },
);

export {};
