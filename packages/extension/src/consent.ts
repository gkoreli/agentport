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
import { randomId, type FormField } from '@agentport/protocol';
import { answerFieldsFrom, consentDenial } from './bridge.js';
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
  // The one line on this card the agent does not write (ADR-023 R4). Below
  // it, `summary` is agent-authored text steered by whatever the agent has
  // been reading, so it can be made to read like anything at all — including
  // like one of the site's own tools. This says which authority is actually
  // being asked about, in words rather than an enum name.
  //
  // The generic case is the one that was silently wrong: a tool the EXTENSION
  // synthesised over a page that declared nothing used to be described as
  // something the site lent, which is false whatever the site could have done
  // itself.
  //
  // A switch with a `never`, not a ternary chain, and the direction matters:
  // a chain's fallthrough was `site_tool`, the LEAST alarming of the three. So
  // a fourth domain would have been described to the user as something the
  // site lent — on the one line of this card that exists to be trusted, and
  // failing toward "harmless". An authority this window cannot name is the one
  // a user most needs telling about, so the default says exactly that, and the
  // `never` makes adding a domain without a sentence a build error.
  const authority = ((): string => {
    switch (state.domain) {
      case 'runtime_own_tool':
        return "Your agent's own tool, on your machine";
      case 'generic_page_tool':
        return `A tool your extension built for this page — ${state.origin} did not provide it`;
      case 'site_tool':
        return `A tool ${state.origin} lent your agent`;
      default: {
        const unhandled: never = state.domain;
        return 'An authority this window cannot name — decline unless you know why it is here';
      }
    }
  })();

  return html`
    <main>
      <header><b>AgentPort</b><span>approval</span></header>
      <section>
        <div class="origin">
          <b>${state.origin}</b>
          <small>Verified origin — reported by the browser, not by the page.</small>
        </div>
        <p class="authority">${authority}</p>
        <p class="surface">${state.agentName} asks: ${state.summary}</p>
        ${when(computed(() => Boolean(args)), () => html`<pre>${args}</pre>`)}
      </section>
      <footer>
        <button type="button" @click=${() => answer(false)}>Decline</button>
        <button class="primary" type="button" @click=${() => answer(true)}>Approve</button>
      </footer>
    </main>`;
});

const Ask = component('ap-consent-ask', () => {
  const state = payload.value as Extract<ConsentPayload, { kind: 'ask' }>;
  /**
   * Field key -> chosen values. A Map, not an object, because these keys came
   * over the wire and `__proto__` is legal by the id pattern — a Map has no
   * prototype chain to walk into. Text fields hold at most one entry.
   */
  const picked = signal<Map<string, string[]>>(new Map());
  const set = (key: string, values: string[]): void => {
    picked.value = new Map(picked.value).set(
      key,
      values.filter((value) => value !== ''),
    );
  };
  const chosen = (key: string): string[] => picked.value.get(key) ?? [];

  const toggle = (field: FormField, option: string): void => {
    const current = chosen(field.key);
    if (field.multi) {
      set(field.key, current.includes(option) ? current.filter((value) => value !== option) : [...current, option]);
    } else {
      // Tapping the chosen option again clears it. The user has to be able to
      // get back to "I did not answer this", which is not the same as any of
      // the options and must not require closing the window.
      set(field.key, current[0] === option ? [] : [option]);
    }
  };

  const submit = (): void => answer(answerFieldsFrom(picked.value));

  const fields = computed(() => state.fields);

  return html`
    <main>
      <header><b>AgentPort</b><span>question</span></header>
      <section>
        <div class="origin">
          <b>${state.origin}</b>
          <small>Verified origin — reported by the browser, not by the page.</small>
        </div>
        <p class="authority">Your agent is asking you. ${state.origin} can neither see this window nor your answer.</p>
        <p class="surface">${state.agentName} asks: ${state.message}</p>
        ${each(
          fields,
          (field) => field.key,
          (field) => {
            const current = field.value;
            const options = current.options ?? [];
            if (options.length === 0) {
              return html`
                <h2>${current.label}</h2>
                <input
                  type="text"
                  placeholder="Leave blank to skip"
                  @input=${(event: Event) => set(current.key, [(event.target as HTMLInputElement).value])}
                />`;
            }
            const optionList = computed(() => options);
            return html`
              <h2>${current.label}</h2>
              ${each(
                optionList,
                (option) => option,
                (option) => {
                  const selected = computed(() => (chosen(current.key).includes(option.value) ? 'true' : 'false'));
                  const label = computed(() => option.value);
                  return html`
                    <button
                      class="agent"
                      type="button"
                      aria-selected=${selected}
                      @click=${() => toggle(current, option.value)}
                    >
                      <span class="grow">${label}</span>
                    </button>`;
                },
              )}`;
          },
        )}
        <p class="hint">Skipping answers nothing and lets your agent carry on with a guess. It is never read as approval.</p>
      </section>
      <footer>
        <button type="button" @click=${() => answer(consentDenial('ask'))}>Skip</button>
        <button class="primary" type="button" @click=${submit}>Send answer</button>
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
    // A switch, not an if/else chain ending in Approve(): each component
    // casts `payload.value` to its own variant, so a kind that fell through
    // to the last branch would render the APPROVAL card for something else
    // entirely, and compile. The `never` makes an unhandled kind a build
    // error instead.
    switch (current.kind) {
      case 'connect':
        return Connect({});
      case 'pair':
        return Pair({});
      case 'approve':
        return Approve({});
      case 'ask':
        return Ask({});
      default: {
        const unhandled: never = current;
        return html`<main><section><p class="hint">Unsupported request.</p></section></main>`;
      }
    }
  });
  return html`${view}`;
});

html`${App({})}`.mount(document.body);

// Escape always means "no" — the same stance as everywhere else: a missing
// answer is a denial, never a default grant.
window.addEventListener('keydown', (event) => {
  const current = payload.value;
  if (event.key === 'Escape' && current) answer(consentDenial(current.kind));
});
// The worker also treats window-close as a denial; answering here as well just
// makes the denial immediate instead of waiting for onRemoved.
window.addEventListener('pagehide', () => {
  if (!answered) {
    answered = true;
    const current = payload.value;
    port.postMessage({
      t: 'consent.answer',
      id: questionId,
      value: current ? consentDenial(current.kind) : null,
    } satisfies ConsentToWorker);
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
