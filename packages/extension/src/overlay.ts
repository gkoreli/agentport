/**
 * Extension-owned in-page UI.
 *
 * The floating shell and the shared protocol-neutral Chat render inside a
 * closed shadow root with its own custom-element registry. The content script
 * runs in Chrome's isolated world; the scoped registry additionally prevents
 * page-defined tag names from participating in this tree.
 *
 * Consent and approval controls remain absent. Those decisions render in
 * extension chrome, never in a page viewport (ADR-009).
 */

import {
  attachScopedShadow,
  computed,
  effect,
  html,
  signal,
  when,
  type Signal,
} from '@nisli/core';
import {
  Chat,
  createChatStore,
  type ChatUpdate,
  type ContentBlock,
} from '../../../src/nisli-ui/ui/chat/index.js';

export interface WidgetHandlers {
  attach(): void;
  detach(): void;
  send(text: string): boolean;
  cancel(): void;
}

export type WidgetPhase = 'idle' | 'attaching' | 'attached';

const STYLE = `
:host, * { box-sizing: border-box; }
:host { --bg:#16161a; --surface:#1d1d22; --line:#303039; --text:#e8e6e3; --muted:#9a97a3; --accent:#8c7dff; --ok:#63d795; }
.root { position:fixed; inset:0; z-index:2147483647; pointer-events:none; font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--text); }
.root > * { pointer-events:auto; }
button, textarea { font:inherit; color:inherit; }
button { cursor:pointer; }
button:focus-visible, textarea:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.fab { position:absolute; right:18px; bottom:18px; width:44px; height:44px; border-radius:50%; background:var(--bg); border:1px solid var(--line); color:var(--text); box-shadow:0 8px 24px rgba(0,0,0,.45); display:grid; place-items:center; font-size:17px; }
.fab.live { border-color:var(--accent); box-shadow:0 0 0 3px rgba(140,125,255,.22),0 8px 24px rgba(0,0,0,.45); }
.panel { position:absolute; right:18px; bottom:74px; width:min(390px,calc(100vw - 36px)); height:min(560px,calc(100vh - 110px)); display:flex; flex-direction:column; background:var(--bg); border:1px solid var(--line); border-radius:14px; box-shadow:0 24px 64px rgba(0,0,0,.55); overflow:hidden; }
.panel > header { min-height:48px; padding:10px 13px; border-bottom:1px solid #28282f; display:flex; align-items:center; gap:8px; }
.panel > header b { font-weight:650; }
.panel > header span { color:var(--muted); font-size:11px; margin-left:auto; }
.panel > header button { border:0; border-radius:7px; padding:5px 8px; background:transparent; color:var(--muted); }
.panel > header button:hover { background:var(--surface); color:var(--text); }
.panel-body { min-height:0; flex:1; display:flex; flex-direction:column; padding:11px 12px 12px; }
.attach { flex:1; display:grid; place-content:center; gap:12px; padding:24px; text-align:center; color:var(--muted); }
.attach button { border:1px solid var(--accent); border-radius:9px; padding:9px 14px; background:var(--accent); color:#fff; font-weight:650; }
.notices { display:grid; gap:5px; padding:0 2px 8px; }
.notice { color:var(--muted); font-size:11px; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
[data-slot="chat"] { display:flex; flex:1; min-height:0; flex-direction:column; gap:9px; }
[data-slot="message-scroller"] { position:relative; display:flex; flex:1; min-height:0; overflow:hidden; }
[data-slot="message-scroller-viewport"] { width:100%; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
[data-slot="message-scroller-content"] { display:flex; min-height:100%; flex-direction:column; padding:2px 2px 14px; }
[data-slot="message-scroller-button"] { position:absolute; left:50%; bottom:8px; z-index:2; transform:translateX(-50%); border:1px solid var(--line); background:var(--surface); color:var(--text); border-radius:999px; padding:5px 10px; font-size:11px; box-shadow:0 5px 18px rgba(0,0,0,.4); }
[data-slot="message-scroller-button"][data-active="false"] { opacity:0; pointer-events:none; }
[data-slot="chat-transcript"] { display:flex; min-width:0; flex-direction:column; gap:12px; }
[data-slot="chat-transcript-empty"] { color:var(--muted); text-align:center; padding:34px 8px; }
[data-slot="message"] { display:flex; min-width:0; width:100%; gap:8px; }
[data-slot="message"][data-align="end"] { justify-content:flex-end; }
[data-slot="bubble"] { min-width:0; max-width:88%; }
[data-slot="bubble"][data-variant="ghost"] { width:100%; max-width:100%; }
[data-slot="bubble-content"] { min-width:0; border-radius:13px; padding:8px 10px; line-height:1.5; overflow-wrap:anywhere; }
[data-slot="bubble"][data-variant="default"] [data-slot="bubble-content"] { background:#302c52; color:#fff; }
[data-slot="bubble"][data-variant="ghost"] [data-slot="bubble-content"] { padding:0 2px; }
[data-slot="bubble"][data-variant="destructive"] [data-slot="bubble-content"] { border:1px solid #78454d; background:#321c21; color:#ffb7bd; }
[data-slot="chat-content"] { display:flex; min-width:0; flex-direction:column; gap:7px; font-size:13px; }
[data-slot="chat-content-text"] { white-space:pre-wrap; overflow-wrap:anywhere; }
[data-slot="chat-content-image"] { display:block; max-width:100%; max-height:320px; border-radius:9px; border:1px solid var(--line); }
[data-slot="chat-content-audio"] { width:100%; }
[data-slot="chat-content-resource"], [data-slot="chat-content-resource-link"] { font:11px/1.5 ui-monospace,monospace; }
[data-slot="chat-content-resource"] { margin:0; max-height:180px; overflow:auto; border:1px solid var(--line); border-radius:8px; background:#101013; padding:8px; color:#d4d1dc; }
[data-slot="chat-content-resource-link"] { display:inline-flex; max-width:100%; border:1px solid var(--line); border-radius:8px; padding:5px 8px; color:#aaa1ff; }
[data-slot="chat-message-caret"] { display:inline-block; width:5px; height:13px; margin-left:3px; background:var(--accent); vertical-align:text-bottom; animation:chat-pulse 1s infinite; }
@keyframes chat-pulse { 50% { opacity:.25; } }
[data-slot="chat-reasoning"], [data-slot="chat-tool-call"] { border:1px solid var(--line); border-radius:9px; background:#121216; overflow:hidden; }
[data-slot="chat-reasoning"] { border-style:dashed; color:var(--muted); }
[data-slot="chat-reasoning-summary"], [data-slot="chat-tool-call-summary"] { display:flex; align-items:center; gap:7px; list-style:none; cursor:pointer; padding:7px 9px; }
[data-slot="chat-reasoning-summary"]::-webkit-details-marker, [data-slot="chat-tool-call-summary"]::-webkit-details-marker { display:none; }
[data-slot="chat-reasoning-preview"], [data-slot="chat-tool-call-name"] { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-slot="chat-reasoning-body"], [data-slot="chat-tool-call-body"] { border-top:1px solid var(--line); padding:8px 9px; }
[data-slot="chat-tool-call-status"] { border-radius:5px; padding:2px 5px; background:#25252c; color:var(--muted); font-size:9px; text-transform:uppercase; }
[data-slot="chat-tool-call"][data-status="complete"] [data-slot="chat-tool-call-status"] { color:var(--ok); }
[data-slot="chat-tool-call"][data-status="error"] [data-slot="chat-tool-call-status"] { color:#ff999f; }
[data-slot="chat-tool-call-input"] pre, [data-slot="chat-tool-call-error"] pre { margin:0; max-height:150px; overflow:auto; white-space:pre-wrap; border:1px solid var(--line); border-radius:7px; background:#101013; padding:7px; font-size:11px; }
[data-slot="chat-queued"] { display:flex; align-items:center; gap:7px; border:1px dashed var(--line); border-radius:8px; padding:6px 8px; font-size:11px; }
[data-slot="chat-queued-status"] { color:var(--muted); font-size:9px; text-transform:uppercase; }
[data-slot="chat-queued-text"] { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[data-slot="chat-queued-remove"] { border:0; background:transparent; color:var(--muted); }
[data-slot="chat-suggestions"] { display:flex; flex-wrap:wrap; gap:6px; }
[data-slot="chat-suggestion"] { border:1px solid var(--line); border-radius:999px; background:transparent; color:var(--text); padding:5px 9px; }
[data-slot="chat-composer-row"] { display:flex; align-items:flex-end; gap:7px; border-top:1px solid var(--line); padding-top:9px; }
[data-slot="chat-composer"] { flex:1; min-width:0; }
[data-slot="chat-composer-form"] { display:flex; align-items:flex-end; gap:6px; border:1px solid var(--line); border-radius:11px; background:#101013; padding:6px; }
[data-slot="chat-composer-form"]:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px rgba(140,125,255,.14); }
[data-slot="chat-composer-input"] { flex:1; min-width:0; min-height:33px; max-height:192px; resize:none; border:0; outline:0; background:transparent; padding:6px; line-height:1.4; }
[data-slot="chat-composer-send"], [data-slot="chat-generation-stop"] { border:1px solid var(--line); border-radius:8px; padding:7px 10px; background:var(--accent); color:#fff; white-space:nowrap; }
[data-slot="chat-generation-stop"] { background:transparent; color:var(--text); }
[data-slot="chat-composer-send"][disabled] { opacity:.4; cursor:default; }
`;

export interface Overlay {
  widget: {
    show(): void;
    phase: Signal<WidgetPhase>;
    agentName: Signal<string>;
    addUserMessage(text: string | readonly ContentBlock[]): string;
    apply(update: ChatUpdate): void;
    notice(text: string): void;
    reset(): void;
  };
}

export function createOverlay(handlers: WidgetHandlers): Overlay {
  const host = document.createElement('div');
  host.setAttribute('data-agentport-ui', '');
  host.style.cssText = 'all: initial;';
  const root = attachScopedShadow(host, { mode: 'closed' });
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
  const notices = signal<string[]>([]);
  const chat = createChatStore();

  const statusLine = computed(() =>
    phase.value === 'attached' ? agentName.value : phase.value === 'attaching' ? 'attaching…' : 'not attached',
  );

  const panelBody = computed(() => {
    if (phase.value !== 'attached') {
      return html`<div class="attach">
        <div>Attach your agent to give it tools over this page.</div>
        <button type="button" disabled="${computed(() => phase.value === 'attaching')}" @click=${handlers.attach}>
          ${computed(() => phase.value === 'attaching' ? 'Attaching…' : 'Attach my agent')}
        </button>
      </div>`;
    }
    return html`<div class="panel-body">
      ${when(computed(() => notices.value.length > 0), () => html`<div class="notices">
        ${computed(() => notices.value.slice(-2).map((notice) => html`<div class="notice">${notice}</div>`))}
      </div>`)}
      ${Chat({
        entries: chat.entries,
        busy: chat.running,
        empty: 'Ask your agent about this page.',
        placeholder: 'Ask your agent…',
        onPrompt: handlers.send,
        onCancel: handlers.cancel,
      })}
    </div>`;
  });

  html`<div class="root">
    ${when(visible, () => html`<button class="fab" type="button" title="AgentPort" @click=${() => { open.value = !open.value; }}>◆</button>`)}
    ${when(computed(() => visible.value && open.value), () => html`<div class="panel">
      <header>
        <b>AgentPort</b><span>${statusLine}</span>
        ${when(computed(() => phase.value === 'attached'), () => html`<button type="button" @click=${handlers.detach}>Detach</button>`)}
      </header>
      ${panelBody}
    </div>`)}
  </div>`.mount(mountPoint);

  effect(() => {
    const fab = root.querySelector('.fab');
    if (fab) fab.classList.toggle('live', phase.value === 'attached');
  });

  return {
    widget: {
      show: () => { visible.value = true; },
      phase,
      agentName,
      addUserMessage: (content) => chat.addUserMessage(content),
      apply: (update) => chat.apply(update),
      notice: (text) => {
        notices.value = [...notices.value, text];
      },
      reset: () => {
        chat.reset();
        notices.value = [];
        phase.value = 'idle';
        agentName.value = '';
      },
    },
  };
}
