/**
 * Extension-owned in-page UI, built with nisli (@nisli/core).
 *
 * This is the Job 2 widget ONLY: the floating ◆ button and its chat panel,
 * rendered inside a *closed* shadow root created by the content script in the
 * isolated world. The page can see that a host element exists and can cover
 * it, but it cannot read the tree or dispatch a trusted click into it.
 *
 * Deliberately absent: any consent or approval control. The picker, the
 * capability screen and every per-call approval render in EXTENSION chrome —
 * a popup window and browser notifications driven by the service worker
 * (ADR-009). A page can pixel-perfectly imitate an in-page dialog and can
 * clickjack anything in its own viewport; it cannot draw a browser window it
 * does not own. This widget shows status; it never decides.
 *
 * Only nisli's template layer is used, deliberately: `component()` registers
 * custom elements in a registry whose isolation from the main world is a
 * browser implementation detail, and a tag the page could pre-empt is a tag
 * the page could implement. Templates own their DOM outright, so the trust
 * story does not depend on that detail. `component()` is used in the popup
 * and the consent window, which run on the extension origin where no page
 * script exists.
 */

import { computed, each, effect, html, signal, when, type ReadonlySignal, type Signal } from '@nisli/core';

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

const STYLE = `
:host, * { box-sizing: border-box; }
.root {
  position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8e6e3;
}
.root > * { pointer-events: auto; }
button { font: inherit; color: inherit; cursor: pointer; border-radius: 8px; }
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
  /** Job 2 widget state, driven by the content script. Status only — no
   *  consent or approval control ever renders in-page. */
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

  const visible = signal(false);
  const open = signal(false);
  const phase = signal<WidgetPhase>('idle');
  const agentName = signal('');
  const messages = signal<Message[]>([]);
  const draft = signal('');

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
