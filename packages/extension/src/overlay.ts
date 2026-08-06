/**
 * Extension-origin fallback surface.
 *
 * This module runs only in overlay.html, never in the content script. Chrome
 * isolates a content script's custom-element constructors from its own global
 * registry, so rendering Nisli components there throws `Illegal constructor`.
 * An extension-origin iframe has one coherent registry and keeps the shared
 * Chat renderer out of the hostile page's JavaScript world.
 */

import { computed, each, html, signal, when } from '@nisli/core';
import { createLogger, type PlanStep } from '@agentport/protocol';
import {
  Chat,
  createChatStore,
  type ChatUpdate,
  type ContentBlock,
} from '../../../src/nisli-ui/ui/chat/index.js';
import { sanitizePlanSteps } from './bridge.js';

export type WidgetPhase = 'idle' | 'attaching' | 'attached';

/** Commands originate in the content script and update this extension UI. */
export type OverlayCommand =
  | { t: 'overlay.show' }
  | { t: 'overlay.state'; phase: WidgetPhase; agentName?: string }
  | { t: 'overlay.notice'; text: string }
  /**
   * The agent's plan for the turn it is running. A SNAPSHOT: this replaces the
   * checklist outright, and an empty array clears it. It is deliberately not a
   * `chat.update` — a plan is what the agent intends now, not something it
   * said, and replaying each revision as a message would read as repetition.
   */
  | { t: 'overlay.plan'; steps: readonly PlanStep[] }
  /**
   * Fingerprint words for the CURRENT attachment. Persistent state, not a
   * notice: a reconnect mints fresh sealing keys (ADR-003), so the words change
   * underneath a user who was comparing them with their daemon's consent
   * screen. They have to stay on screen to be comparable at all.
   */
  | { t: 'overlay.verify'; words: string }
  | { t: 'chat.add-user'; content: string | readonly ContentBlock[] }
  | { t: 'chat.update'; update: ChatUpdate }
  | { t: 'chat.reset' }
  | { t: 'overlay.action-result'; id: string; accepted: boolean };

/** Actions originate in the iframe and are interpreted by the content script. */
export type OverlayAction =
  | { t: 'overlay.attach' }
  | { t: 'overlay.detach' }
  | { t: 'overlay.layout'; expanded: boolean }
  | { t: 'chat.prompt'; id: string; text: string }
  | { t: 'chat.cancel' };

const STYLE = `
:root, body { width:100%; height:100%; margin:0; overflow:hidden; }
:root, * { box-sizing:border-box; }
:root { --bg:#16161a; --surface:#1d1d22; --line:#303039; --text:#e8e6e3; --muted:#9a97a3; --accent:#8c7dff; --ok:#63d795; }
body { font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--text); }
#agentport-overlay { width:100%; height:100%; }
.root { width:100%; height:100%; display:flex; flex-direction:column; align-items:stretch; gap:12px; padding:18px; pointer-events:none; }
.root > * { pointer-events:auto; }
button, textarea { font:inherit; color:inherit; }
button { cursor:pointer; }
button:focus-visible, textarea:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.fab { order:2; flex:0 0 44px; align-self:flex-end; width:44px; height:44px; border-radius:50%; background:var(--bg); border:1px solid var(--line); color:var(--text); box-shadow:0 8px 24px rgba(0,0,0,.45); display:grid; place-items:center; font-size:17px; }
.fab.live { border-color:var(--accent); box-shadow:0 0 0 3px rgba(140,125,255,.22),0 8px 24px rgba(0,0,0,.45); }
.panel { order:1; flex:1 1 auto; min-height:0; width:100%; display:flex; flex-direction:column; background:var(--bg); border:1px solid var(--line); border-radius:14px; box-shadow:0 24px 64px rgba(0,0,0,.55); overflow:hidden; }
.panel > header { min-height:48px; padding:10px 13px; border-bottom:1px solid #28282f; display:flex; align-items:center; gap:8px; }
.panel > header b { font-weight:650; }
.panel > header span { color:var(--muted); font-size:11px; margin-left:auto; }
.panel > header button { border:0; border-radius:7px; padding:5px 8px; background:transparent; color:var(--muted); }
.panel > header button:hover { background:var(--surface); color:var(--text); }
.panel-body { min-height:0; flex:1; display:flex; flex-direction:column; padding:11px 12px 12px; }
.chat-shell { display:none; min-height:0; flex:1; flex-direction:column; }
.chat-shell.active { display:flex; }
.attach { flex:1; display:grid; place-content:center; gap:12px; padding:24px; text-align:center; color:var(--muted); }
.attach button { border:1px solid var(--accent); border-radius:9px; padding:9px 14px; background:var(--accent); color:#fff; font-weight:650; }
.notices { display:grid; gap:5px; padding:0 2px 8px; }
.notice { color:var(--muted); font-size:11px; }
.verify { color:var(--muted); font-size:10px; letter-spacing:.04em; padding:0 2px 7px; }
.verify code { font:10px/1.4 ui-monospace,monospace; color:#cfd6e2; }
.plan { border:1px solid var(--line); border-radius:10px; background:#12161d; padding:9px 11px; margin-bottom:9px; display:grid; gap:6px; }
.plan-label { color:var(--muted); font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
.plan ol { margin:0; padding:0; list-style:none; display:grid; gap:4px; }
.plan-step { display:grid; grid-template-columns:14px 1fr; gap:7px; align-items:baseline; font-size:12px; line-height:1.45; color:var(--muted); }
.plan-mark { font-size:11px; text-align:center; }
.plan-step[data-status="active"] { color:var(--text); }
.plan-step[data-status="active"] .plan-mark { color:var(--accent); }
.plan-step[data-status="done"] .plan-mark { color:var(--ok); }
.plan-step[data-status="done"] span:last-child { text-decoration:line-through; opacity:.7; }
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

const log = createLogger('extension.overlay');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPortMessage(value: unknown): value is { t: string } {
  return isRecord(value) && typeof value.t === 'string';
}

/** Mount exactly one Chat renderer in the extension page's ordinary registry. */
export function mountOverlay(port: MessagePort): void {
  const visible = signal(false);
  const expanded = signal(false);
  const phase = signal<WidgetPhase>('idle');
  const agentName = signal('');
  const notices = signal<Array<{ id: number; text: string }>>([]);
  // Attachment state, deliberately outside the chat store: neither is anything
  // the agent *said*, and both are replaced wholesale rather than accumulated.
  const plan = signal<readonly PlanStep[]>([]);
  const verify = signal('');
  const chat = createChatStore();
  const pendingPrompts = new Map<string, (accepted: boolean) => void>();
  let noticeSeq = 0;
  let promptSeq = 0;

  const post = (action: OverlayAction) => port.postMessage(action);
  const statusLine = computed(() =>
    phase.value === 'attached' ? agentName.value : phase.value === 'attaching' ? 'attaching…' : 'not attached',
  );
  const attached = computed(() => phase.value === 'attached');

  const requestPrompt = (text: string): Promise<boolean> => {
    const id = `prompt-${++promptSeq}`;
    return new Promise((resolve) => {
      pendingPrompts.set(id, resolve);
      post({ t: 'chat.prompt', id, text });
    });
  };

  const toggle = (): void => {
    expanded.value = !expanded.value;
    post({ t: 'overlay.layout', expanded: expanded.value });
  };

  const panelBody = html`<div class="panel-body">
    ${when(computed(() => !attached.value), () => html`<div class="attach">
        <div>Attach your agent to give it tools over this page.</div>
        <button type="button" disabled="${computed(() => phase.value === 'attaching')}" @click=${() => post({ t: 'overlay.attach' })}>
          ${computed(() => phase.value === 'attaching' ? 'Attaching…' : 'Attach my agent')}
        </button>
      </div>`)}
    <div class="chat-shell" class:active="${attached}" inert="${computed(() => !attached.value)}">
      ${when(
        computed(() => verify.value !== ''),
        () => html`<div class="verify" title="Compare these words with your agent's consent screen">
          verify <code>${verify}</code>
        </div>`,
      )}
      <div class="notices">${each(
        notices,
        (notice) => notice.id,
        (notice) => html`<div class="notice">${computed(() => notice.value.text)}</div>`,
      )}</div>
      ${when(
        computed(() => plan.value.length > 0),
        () => html`<section class="plan" aria-label="Agent plan">
          <div class="plan-label">Plan</div>
          <ol>
            ${each(
              plan,
              (step, index) => `${index}:${step.text}`,
              (step) => {
                const status = computed(() => step.value.status);
                const mark = computed(() =>
                  step.value.status === 'done' ? '✓' : step.value.status === 'active' ? '▸' : '○',
                );
                return html`<li class="plan-step" data-status=${status}>
                  <span class="plan-mark" aria-hidden="true">${mark}</span>
                  <span>${computed(() => step.value.text)}</span>
                </li>`;
              },
            )}
          </ol>
        </section>`,
      )}
      ${Chat({
        entries: chat.entries,
        busy: chat.running,
        empty: 'Ask your agent about this page.',
        placeholder: 'Ask your agent…',
        onPrompt: requestPrompt,
        onCancel: () => post({ t: 'chat.cancel' }),
      })}
    </div>
  </div>`;

  const mount = document.getElementById('agentport-overlay');
  if (!mount) throw new Error('overlay.html is missing #agentport-overlay');
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  html`<div class="root">
    ${when(visible, () => html`<button class="fab" class:live="${computed(() => phase.value === 'attached')}" type="button" title="AgentPort" @click=${toggle}>◆</button>`)}
    ${when(computed(() => visible.value && expanded.value), () => html`<div class="panel">
      <header>
        <b>AgentPort</b><span>${statusLine}</span>
        ${when(computed(() => phase.value === 'attached'), () => html`<button type="button" @click=${() => post({ t: 'overlay.detach' })}>Detach</button>`)}
      </header>
      ${panelBody}
    </div>`)}
  </div>`.mount(mount);

  port.onmessage = (event: MessageEvent<unknown>) => {
    const raw = event.data;
    if (!isPortMessage(raw)) return;
    const command = raw as OverlayCommand;
    switch (command.t) {
      case 'overlay.show':
        visible.value = true;
        return;
      case 'overlay.state':
        if (command.phase === 'idle' || command.phase === 'attaching' || command.phase === 'attached') {
          phase.value = command.phase;
          agentName.value = typeof command.agentName === 'string' ? command.agentName : '';
        }
        return;
      case 'overlay.notice':
        if (typeof command.text === 'string') notices.value = [...notices.value.slice(-1), { id: ++noticeSeq, text: command.text }];
        return;
      case 'overlay.plan': {
        // Rebuilt here rather than trusted, with the SAME validator the content
        // script used — there is one definition of a renderable plan, not one
        // per hop. A snapshot that does not survive it is refused whole: half a
        // checklist would show intent the agent never expressed.
        const steps = sanitizePlanSteps(command.steps);
        if (!steps) {
          // Unreachable unless the content script and this frame disagree: it
          // validates with this same function before sending. Keep whatever is
          // already on screen, and say so rather than diverge in silence.
          log.error('refused an unrenderable plan snapshot from the content script');
          return;
        }
        plan.value = steps;
        return;
      }
      case 'overlay.verify':
        if (typeof command.words === 'string') verify.value = command.words;
        return;
      case 'chat.add-user':
        if (typeof command.content === 'string' || Array.isArray(command.content)) chat.addUserMessage(command.content as string | ContentBlock[]);
        return;
      case 'chat.update':
        if (isRecord(command.update) && typeof command.update.type === 'string') chat.apply(command.update as ChatUpdate);
        return;
      case 'chat.reset':
        chat.reset();
        notices.value = [];
        // A reset is "this panel now shows nothing about an attachment", so the
        // plan and the fingerprint words go with it. The content script restates
        // whatever is still current through `showWidgetAttached`.
        plan.value = [];
        verify.value = '';
        phase.value = 'idle';
        agentName.value = '';
        return;
      case 'overlay.action-result': {
        if (typeof command.id !== 'string' || typeof command.accepted !== 'boolean') return;
        const resolve = pendingPrompts.get(command.id);
        pendingPrompts.delete(command.id);
        resolve?.(command.accepted);
        return;
      }
      default:
        return;
    }
  };
  port.start();
}

// `content.ts` transfers the only MessagePort after the iframe loads. The page
// cannot reach this frame through the closed shadow root to forge that setup.
const acceptBridge = (event: MessageEvent<unknown>): void => {
  if (
    event.source !== window.parent ||
    !isRecord(event.data) ||
    event.data.t !== 'agentport.overlay.connect' ||
    event.data.secret !== location.hash.slice(1)
  ) return;
  const port = event.ports[0];
  if (!port) return;
  window.removeEventListener('message', acceptBridge);
  mountOverlay(port);
};
window.addEventListener('message', acceptBridge);
