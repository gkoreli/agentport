/**
 * Extension-owned UI, built with nisli (@nisli/core).
 *
 * The picker, the consent screen and every approval card render here — inside a
 * *closed* shadow root created by the content script, in the isolated world.
 * The page can see that a host element exists and can cover it, but it cannot
 * read the tree, cannot read what the user is about to approve, and cannot
 * dispatch a trusted click into it. A consent dialog drawn in page DOM would be
 * a dialog the site can both read and forge, which is exactly the thing this
 * extension exists to stop.
 *
 * Only nisli's template layer is used, deliberately: `component()` registers
 * custom elements in a registry whose isolation from the main world is a
 * browser implementation detail, and a tag the page could pre-empt is a tag the
 * page could implement. Templates own their DOM outright, so the trust story
 * does not depend on that detail. `component()` is used in the popup, which
 * runs on the extension origin where no page script exists.
 */

import { computed, each, effect, html, signal, when, type ReadonlySignal, type Signal } from '@nisli/core';
import type { AgentRow, PageConnectRequest } from './bridge.js';

export interface ApprovalAsk {
  summary: string;
  call?: { name: string; arguments: Record<string, unknown> };
  /** Set by the caller when it can phrase the call better than the tool name. */
  detail?: string;
}

export interface WidgetHandlers {
  attach(): void;
  detach(): void;
  send(text: string): void;
}

export type WidgetPhase = 'idle' | 'attaching' | 'attached';

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'note';
  text: string;
}

type Modal =
  | { kind: 'pick'; agents: AgentRow[]; request: PageConnectRequest; resolve: (value: string | null) => void }
  | { kind: 'consent'; agent: AgentRow; request: PageConnectRequest; resolve: (value: boolean) => void }
  | { kind: 'approve'; ask: ApprovalAsk; resolve: (value: boolean) => void };

const STYLE = `
:host, * { box-sizing: border-box; }
.root {
  position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8e6e3;
}
.root > * { pointer-events: auto; }
button { font: inherit; color: inherit; cursor: pointer; border-radius: 8px; }
.scrim {
  position: absolute; inset: 0; background: rgba(8,8,10,.62);
  backdrop-filter: blur(2px); display: grid; place-items: center; padding: 24px;
}
.card {
  width: min(440px, 100%); max-height: 80vh; overflow: auto;
  background: #16161a; border: 1px solid #2c2c33; border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0,0,0,.55); padding: 20px;
}
.card h2 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
.card .sub { margin: 0 0 14px; color: #9a97a3; font-size: 12px; word-break: break-all; }
.rows { display: grid; gap: 6px; margin-bottom: 14px; }
.agent {
  display: flex; gap: 10px; align-items: center; text-align: left; width: 100%;
  background: #1d1d22; border: 1px solid #2c2c33; padding: 10px 12px;
}
.agent[aria-selected="true"] { border-color: #7c6cff; background: #23213a; }
.agent:disabled { opacity: .45; cursor: not-allowed; }
.agent small { display: block; color: #9a97a3; font-size: 11px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #4b4b55; flex: none; }
.dot.on { background: #4ade80; }
ul { margin: 0 0 12px; padding-left: 18px; }
li { margin: 2px 0; }
li.ask { color: #fbbf24; }
.label { color: #9a97a3; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin: 10px 0 4px; }
pre {
  margin: 0 0 12px; padding: 10px; background: #0f0f12; border: 1px solid #2c2c33;
  border-radius: 8px; overflow: auto; max-height: 180px; font-size: 11px; white-space: pre-wrap; word-break: break-word;
}
.foot { display: flex; gap: 8px; justify-content: flex-end; }
.btn { padding: 8px 14px; background: #24242b; border: 1px solid #33333c; }
.btn.primary { background: #7c6cff; border-color: #7c6cff; color: #fff; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.fab {
  position: absolute; right: 18px; bottom: 18px; width: 44px; height: 44px;
  border-radius: 50%; background: #16161a; border: 1px solid #33333c;
  box-shadow: 0 8px 24px rgba(0,0,0,.45); display: grid; place-items: center; font-size: 17px;
}
.fab.live { border-color: #7c6cff; box-shadow: 0 0 0 3px rgba(124,108,255,.22), 0 8px 24px rgba(0,0,0,.45); }
.panel {
  position: absolute; right: 18px; bottom: 74px; width: min(360px, calc(100vw - 36px));
  max-height: min(520px, calc(100vh - 120px)); display: flex; flex-direction: column;
  background: #16161a; border: 1px solid #2c2c33; border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0,0,0,.55); overflow: hidden;
}
.panel header { padding: 12px 14px; border-bottom: 1px solid #26262c; display: flex; align-items: center; gap: 8px; }
.panel header b { font-weight: 600; }
.panel header span { color: #9a97a3; font-size: 11px; margin-left: auto; }
.log { flex: 1; overflow: auto; padding: 12px 14px; display: grid; gap: 8px; align-content: start; }
.msg { padding: 8px 10px; border-radius: 10px; background: #1d1d22; white-space: pre-wrap; word-break: break-word; }
/* Roles are prefixed because a bare .user/.agent would collide with the
   picker's own classes inside this one stylesheet. */
.msg.msg-user { background: #23213a; }
.msg.msg-note { background: transparent; color: #9a97a3; font-size: 11px; padding: 0 2px; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #26262c; }
input[type=text] {
  flex: 1; background: #0f0f12; border: 1px solid #2c2c33; border-radius: 8px;
  padding: 8px 10px; color: inherit; font: inherit;
}
input[type=text]:focus, button:focus-visible { outline: 2px solid #7c6cff; outline-offset: 1px; }
.empty { color: #9a97a3; padding: 16px 4px; text-align: center; }
`;

export interface Overlay {
  pick(agents: AgentRow[], request: PageConnectRequest): Promise<string | null>;
  consent(agent: AgentRow, request: PageConnectRequest): Promise<boolean>;
  approve(ask: ApprovalAsk): Promise<boolean>;
  /** Job 2 widget state, driven by the content script. */
  widget: {
    show(): void;
    phase: Signal<WidgetPhase>;
    agentName: Signal<string>;
    note(text: string): void;
    say(role: Message['role'], text: string): string;
    appendTo(id: string, text: string): void;
    reset(): void;
  };
}

export function createOverlay(handlers: WidgetHandlers): Overlay {
  const host = document.createElement('div');
  host.setAttribute('data-agentport-ui', '');
  // `all: initial` keeps a site's `* { }` rules out of our chrome; the closed
  // root keeps the site's scripts out of it.
  host.style.cssText = 'all: initial;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
  const mountPoint = document.createElement('div');
  root.append(mountPoint);
  (document.documentElement ?? document.body).append(host);

  const queue: Modal[] = [];
  const modal = signal<Modal | null>(null);
  const visible = signal(false);
  const open = signal(false);
  const phase = signal<WidgetPhase>('idle');
  const agentName = signal('');
  const messages = signal<Message[]>([]);
  const draft = signal('');

  function present(next: Modal): void {
    if (modal.value) queue.push(next);
    else modal.value = next;
  }

  function settle<T>(value: T, resolve: (value: T) => void): void {
    resolve(value);
    modal.value = queue.shift() ?? null;
  }

  // Escape always means "no". A missing answer is a denial, never a default
  // grant — the same stance the daemon takes on approvals.
  root.addEventListener('keydown', (event) => {
    const current = modal.value;
    if (!current || (event as KeyboardEvent).key !== 'Escape') return;
    event.stopPropagation();
    if (current.kind === 'pick') settle(null, current.resolve);
    else settle(false, current.resolve as (value: boolean) => void);
  });

  // --- modal views ---------------------------------------------------------

  function pickCard(state: Extract<Modal, { kind: 'pick' }>) {
    const selected = signal<string | null>(null);
    const rows = signal(state.agents);
    return html`
      <div class="card" role="dialog" aria-modal="true">
        <h2>Attach an agent</h2>
        <p class="sub">${state.request.name} · ${location.origin}</p>
        <div class="rows">
          ${each(rows, (agent) => agent.agent, (agent) => {
            const chosen = computed(() => (selected.value === agent.value.agent ? 'true' : 'false'));
            return html`
              <button
                class="agent"
                type="button"
                aria-selected=${chosen}
                disabled=${!agent.value.online}
                @click=${() => { selected.value = agent.value.agent; }}
              >
                <span class="dot" class:on=${agent.value.online}></span>
                <span>${agent.value.name}
                  <small>${agent.value.runtime} · ${agent.value.location ?? 'unknown'} · ${agent.value.online ? 'Online' : 'Offline'}</small>
                </span>
              </button>`;
          })}
        </div>
        <div class="foot">
          <button class="btn" type="button" @click=${() => settle(null, state.resolve)}>Cancel</button>
          <button
            class="btn primary"
            type="button"
            @click=${() => settle(selected.value, state.resolve)}
          >Continue</button>
        </div>
      </div>`;
  }

  function consentCard(state: Extract<Modal, { kind: 'consent' }>) {
    const ask = new Set(state.request.alwaysAsk ?? []);
    const free = state.request.tools.filter((tool) => !ask.has(tool.name) && !tool.requiresApproval);
    const gated = state.request.tools.filter((tool) => ask.has(tool.name) || tool.requiresApproval);
    return html`
      <div class="card" role="dialog" aria-modal="true">
        <h2>Lend capabilities</h2>
        <p class="sub">${state.request.name} → ${state.agent.name} · ${location.origin}</p>
        <div class="label">Allowed for this session</div>
        <ul>${free.length ? free.map((tool) => html`<li>${tool.description}</li>`) : html`<li>—</li>`}</ul>
        <div class="label">Asks every time</div>
        <ul>${gated.length ? gated.map((tool) => html`<li class="ask">${tool.description}</li>`) : html`<li>—</li>`}</ul>
        <div class="foot">
          <button class="btn" type="button" @click=${() => settle(false, state.resolve)}>Deny</button>
          <button class="btn primary" type="button" @click=${() => settle(true, state.resolve)}>Allow</button>
        </div>
      </div>`;
  }

  function approveCard(state: Extract<Modal, { kind: 'approve' }>) {
    const args = state.ask.call ? JSON.stringify(state.ask.call.arguments, null, 2) : '';
    return html`
      <div class="card" role="dialog" aria-modal="true">
        <h2>${state.ask.detail ?? state.ask.summary}</h2>
        <p class="sub">${state.ask.call?.name ?? 'agent request'} · ${location.origin}</p>
        ${when(Boolean(args), () => html`<pre>${args}</pre>`)}
        <div class="foot">
          <button class="btn" type="button" @click=${() => settle(false, state.resolve)}>Deny</button>
          <button class="btn primary" type="button" @click=${() => settle(true, state.resolve)}>Approve</button>
        </div>
      </div>`;
  }

  const modalView = computed(() => {
    const current = modal.value;
    if (!current) return null;
    if (current.kind === 'pick') return pickCard(current);
    if (current.kind === 'consent') return consentCard(current);
    return approveCard(current);
  });

  // --- widget --------------------------------------------------------------

  const statusLine = computed(() =>
    phase.value === 'attached' ? agentName.value : phase.value === 'attaching' ? 'attaching…' : 'not attached',
  );

  const panel = () => html`
    <div class="panel">
      <header>
        <b>AgentPort</b><span>${statusLine}</span>
      </header>
      <div class="log">
        ${when(computed(() => messages.value.length === 0), () =>
          html`<div class="empty">Attach your agent to give it tools over this page.</div>`)}
        ${each(messages, (message) => message.id, (message) => {
          const cls = computed(() => `msg msg-${message.value.role}`);
          const text = computed(() => message.value.text);
          return html`<div class=${cls}>${text}</div>`;
        })}
      </div>
      <form @submit.prevent=${() => {
        const text = draft.value.trim();
        if (!text) return;
        draft.value = '';
        if (phase.value === 'attached') handlers.send(text);
      }}>
        ${when(computed(() => phase.value !== 'attached'), () =>
          html`<button class="btn primary" type="button" style="flex:1" @click=${() => handlers.attach()}>
            Attach my agent
          </button>`)}
        ${when(computed(() => phase.value === 'attached'), () => html`
          <input type="text" placeholder="Ask your agent…" @input=${(event: Event) => {
            draft.value = (event.target as HTMLInputElement).value;
          }} />
          <button class="btn" type="button" @click=${() => handlers.detach()}>Detach</button>`)}
      </form>
    </div>`;

  const view = html`
    <div class="root">
      ${when(visible, () => html`
        <button class="fab" type="button" title="AgentPort" @click=${() => { open.value = !open.value; }}>◆</button>`)}
      ${when(computed(() => visible.value && open.value), panel)}
      ${when(computed(() => modal.value !== null), () => html`<div class="scrim">${modalView}</div>`)}
    </div>`;

  view.mount(mountPoint);

  // The FAB carries the only always-visible signal that an agent is attached to
  // this page; a site cannot suppress it because it lives in our shadow root.
  effect(() => {
    const fab = root.querySelector('.fab');
    if (fab) fab.classList.toggle('live', phase.value === 'attached');
  });

  // Clear the draft box when a send empties the signal.
  effect(() => {
    const field = root.querySelector<HTMLInputElement>('input[type=text]');
    if (field && draft.value === '' && field.value !== '') field.value = '';
  });

  let seq = 0;

  return {
    pick: (agents, request) =>
      new Promise((resolve) => {
        visible.value = true;
        present({ kind: 'pick', agents, request, resolve });
      }),
    consent: (agent, request) => new Promise((resolve) => present({ kind: 'consent', agent, request, resolve })),
    approve: (ask) => new Promise((resolve) => present({ kind: 'approve', ask, resolve })),
    widget: {
      show: () => { visible.value = true; },
      phase,
      agentName,
      note: (text) => {
        messages.value = [...messages.value, { id: `n${++seq}`, role: 'note', text }];
      },
      say: (role, text) => {
        const id = `m${++seq}`;
        messages.value = [...messages.value, { id, role, text }];
        open.value = true;
        return id;
      },
      appendTo: (id, text) => {
        messages.value = messages.value.map((message) =>
          message.id === id ? { ...message, text: message.text + text } : message,
        );
      },
      reset: () => {
        messages.value = [];
        phase.value = 'idle';
        agentName.value = '';
      },
    },
  };
}

export type { ReadonlySignal };
