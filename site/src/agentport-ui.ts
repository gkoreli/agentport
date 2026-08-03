declare const __AGENTPORT_VERSION__: string | undefined;

/** Baked in by site/build.ts; 'dev' under tsx/test runners with no define. */
const VERSION = typeof __AGENTPORT_VERSION__ === 'string' ? __AGENTPORT_VERSION__ : 'dev';

/**
 * The demo's agent panel, in nisli — rendered by the @nisli/ui ACP set.
 *
 * Note what is no longer here: no key, no `AgentWallet`, no picker, no consent
 * screen. Those moved to where the user's key actually is — an extension, or
 * their terminal via `connect.js`. This file is an honest example of what a
 * *site* writes, and nothing more.
 *
 * The transcript is `createTranscript()` + `AcpChat` from the copied
 * `src/nisli-ui` ACP set. The session is consumed through @agentport/agui
 * (ADR-017): the panel subscribes to the same AG-UI event stream a
 * third-party renderer would, and `wire()` folds those events into the
 * `session/update` shapes the reducer understands. The demo is thereby the
 * adapter's first real consumer — if the mapping breaks, our own panel
 * breaks first.
 *
 * Styling: the copied components carry Tailwind classes the site does not
 * build (no Tailwind pipeline here, by choice). Presentation comes from the
 * `data-slot` contract instead — see the "ACP set" section of styles.css.
 *
 * This is our own page rather than an injected surface, so `component()` is
 * safe here; the injected modal deliberately avoids it (see modal.ts).
 */

import { component, computed, html, signal, when } from '@nisli/core';
import AgentPortConnect from './connect.js';
import { onAguiEvent, type AguiEvent } from '@agentport/agui';
import type { AgentSession, SessionEvents, SiteTool } from '@agentport/client';
import type { HistoryEntry } from '@agentport/protocol';
import { AcpChat } from '../../src/nisli-ui/ui/acp/acp-chat.js';
import { createTranscript } from '../../src/nisli-ui/lib/acp-session.js';

export type { SiteTool };

export interface SurfaceConfig {
  name: string;
  route?: string;
  context?: Record<string, unknown>;
  tools: SiteTool[];
  alwaysAsk?: string[];
  placeholder?: string;
  suggestions?: string[];
  /**
   * Receives the panel's API once it exists, so the page can send prompts it
   * composed itself (e.g. inkwell's annotations). Returns false when no
   * session is live — the caller should tell the user to connect first.
   */
  bind?: (panel: PanelApi) => void;
}

export interface PanelApi {
  send(text: string): boolean;
  get live(): boolean;
}

const text = (t: string) => ({ type: 'text' as const, text: t });

/** Guess a ToolKind from a namespaced tool name — for the glyph only. */
function kindOf(name: string): 'read' | 'edit' | 'search' | 'other' {
  if (/read|get|list|fetch/i.test(name)) return 'read';
  if (/write|replace|update|set|append|complete|add/i.test(name)) return 'edit';
  if (/search|find|query/i.test(name)) return 'search';
  return 'other';
}

const AgentPanel = component<{ config: SurfaceConfig }>('agent-panel', (props) => {
  // nisli props are signals — `props.config` is Signal<SurfaceConfig>, not the
  // object. Casting instead of reading `.value` silently yields undefined
  // fields, which is exactly how the connect button died quietly once already.
  const config = props.config.value;

  const transcript = createTranscript();
  const status = signal('not connected');
  const online = signal(false);
  const live = signal(false);
  const busy = signal(false);
  const notice = signal('');

  let session: AgentSession | null = null;
  let toolSeq = 0;
  // prompt() keeps its id private, but every turn event carries it — track the
  // live turn here so Cancel can address it.
  let currentPromptId: string | null = null;

  // PROVENANCE. The site stores no transcript at all — not in localStorage,
  // not in sessionStorage, nowhere. On reload the panel re-attaches to the
  // session and asks the AGENT for the conversation, which lives in the
  // user's own agent session store on their own machine. The relay stores
  // none of it either.

  /**
   * The panel consumes the session through @agentport/agui (ADR-017) — the
   * same event stream any third-party AG-UI renderer would get, so the demo
   * itself proves the adapter. AG-UI events → ACP `session/update` shapes for
   * the transcript reducer. Tool rows are terminal here, so TOOL_CALL_END's
   * rawEvent (the completed call, results included) is the one that renders;
   * approvals were decided in the wallet, so the panel records outcomes and
   * never draws a consent control of its own.
   */
  const wire = (next: AgentSession) =>
    onAguiEvent(next, (event: AguiEvent) => {
      switch (event.type) {
        case 'TEXT_MESSAGE_START':
          currentPromptId = event.messageId;
          return;
        case 'TEXT_MESSAGE_CONTENT':
          transcript.apply({ sessionUpdate: 'agent_message_chunk', content: text(event.delta) });
          return;
        case 'REASONING_START':
          currentPromptId = event.messageId.replace(/:reasoning$/, '');
          return;
        case 'REASONING_MESSAGE_CONTENT':
          transcript.apply({ sessionUpdate: 'agent_thought_chunk', content: text(event.delta) });
          return;
        case 'TOOL_CALL_END': {
          const call = event.rawEvent as SessionEvents['tool'];
          const detail = call.ok
            ? call.result !== undefined
              ? JSON.stringify(call.result, null, 2)
              : undefined
            : (call.error ?? 'failed');
          transcript.apply({
            sessionUpdate: 'tool_call',
            toolCallId: `t${toolSeq++}`,
            title: call.name,
            kind: kindOf(call.name),
            status: call.ok ? 'completed' : 'failed',
            rawInput: call.arguments,
            content: detail === undefined ? undefined : [{ type: 'content', content: text(detail) }],
          });
          return;
        }
        case 'RUN_FINISHED':
        case 'RUN_ERROR':
          currentPromptId = null;
          transcript.endTurn();
          busy.value = false;
          if (event.type === 'RUN_ERROR') notice.value = event.message;
          return;
        case 'CUSTOM':
          if (event.name === 'agentport.approval') {
            const approval = event.value;
            transcript.apply({
              sessionUpdate: 'tool_call',
              toolCallId: `a${toolSeq++}`,
              title: approval.summary,
              kind: 'other',
              status: approval.granted ? 'completed' : 'cancelled',
              rawInput: approval.call?.arguments,
            });
          } else if (event.name === 'agentport.closed') {
            notice.value = `session closed (${event.value.reason})`;
            status.value = 'disconnected';
            online.value = false;
            live.value = false;
            busy.value = false;
            session = null;
            currentPromptId = null;
          }
          return;
        default:
          return;
      }
    });

  const attach = (next: AgentSession) => {
    session = next;
    live.value = true;
    online.value = true;
    status.value = `${next.info.agentName} · ${next.info.runtime}`;
    notice.value = `connected · ${next.grant.tools.length} tools lent · expires ${new Date(
      next.grant.expiresAt,
    ).toLocaleTimeString()}`;
    wire(next);
  };

  /** Replay the agent's own history through the reducer, one settled entry each. */
  const seed = (history: HistoryEntry[]) => {
    transcript.reset();
    for (const entry of history) {
      switch (entry.role) {
        case 'user':
          transcript.apply({ sessionUpdate: 'user_message_chunk', content: text(entry.text) });
          break;
        case 'agent':
          transcript.apply({ sessionUpdate: 'agent_message_chunk', content: text(entry.text) });
          break;
        case 'thought':
          transcript.apply({ sessionUpdate: 'agent_thought_chunk', content: text(entry.text) });
          break;
        default:
          // tool / approval history rows arrive as flat text.
          transcript.apply({
            sessionUpdate: 'tool_call',
            toolCallId: `h${toolSeq++}`,
            title: entry.text,
            status: 'completed',
          });
      }
      // History entries are complete messages; settle after each so
      // consecutive same-role rows stay separate instead of coalescing the
      // way a live stream should.
      transcript.endTurn();
    }
  };

  /**
   * A refresh should not throw away a live agent. Restore what was on screen,
   * then try to re-attach to the session itself; if the session is gone the
   * panel falls back to the ordinary Connect button.
   */
  const restore = async () => {
    try {
      const resumed = await AgentPortConnect.resume({
        name: config.name,
        route: config.route,
        context: config.context,
        tools: config.tools,
        alwaysAsk: config.alwaysAsk,
      });
      if (!resumed) return;
      attach(resumed.session);

      // Hydrate from the agent's own store rather than from anything we kept.
      const history = await resumed.session.history();
      seed(history);
      notice.value = `reconnected · ${history.length} message(s) restored from your agent`;
    } catch (err) {
      console.error('[agentport] resume failed', err);
      notice.value = `could not reconnect: ${(err as Error).message}`;
    }
  };
  void restore();

  const connect = () => {
    // [SURFACE] The entire integration. An installed wallet is used if present;
    // otherwise the drop-in widget carries the request to the user's terminal.
    AgentPortConnect.connect({
      name: config.name,
      route: config.route,
      context: config.context,
      tools: config.tools,
      alwaysAsk: config.alwaysAsk,
    })
      .then(attach)
      .catch((err: Error) => {
        // A user dismissing the dialog is not an error. Anything else is, and
        // it goes both on screen and to the console — the previous version put
        // it in a hidden element, which is how a thrown TypeError looked
        // exactly like the button doing nothing.
        if (/cancelled/i.test(err.message)) return;
        console.error('[agentport] connect failed', err);
        notice.value = `connect failed: ${err.message}`;
      });
  };

  const onPrompt = (prompt: string): boolean => {
    if (!session) return false;
    transcript.apply({ sessionUpdate: 'user_message_chunk', content: text(prompt) });
    transcript.endTurn();
    busy.value = true;
    // Failures surface through the AG-UI stream as RUN_ERROR (which settles
    // busy and the turn); the console line is for developers.
    session.prompt(prompt).catch((err: Error) => console.error('[agentport] prompt failed', err));
    return true;
  };

  config.bind?.({
    send: (prompt) => onPrompt(prompt),
    get live() {
      return live.value;
    },
  });

  const onCancel = () => {
    if (session && currentPromptId) session.cancel(currentPromptId);
  };

  const empty = config.suggestions?.length
    ? `Ask your agent something — try: ${config.suggestions.join(' · ')}`
    : 'Ask your agent something.';

  return html`
    <div class="ap-head">
      <span>Agent <span class="ap-version" title="AgentPort build">v${VERSION}</span></span
      ><span class="ap-status" class:online=${online}>${status}</span>
    </div>

    ${when(
      computed(() => !live.value),
      () => html`
        <div class="ap-empty">
          <p class="ap-pitch">
            Bring your own agent.<br />This site never sees your model, keys, or memory.
          </p>
          <button class="ap-connect" @click=${connect}>Connect agent</button>
          <p class="ap-alt">No install. Your agent approves from wherever it runs.</p>
        </div>
      `,
    )}

    <div class="ap-chat" class:live=${live}>
      ${when(
        computed(() => notice.value !== ''),
        () => html`<div class="ap-notice">${notice}</div>`,
      )}
      ${AcpChat({
        entries: transcript.entries,
        onPrompt,
        onCancel,
        busy,
        empty,
        placeholder: config.placeholder ?? 'Ask your agent…',
      })}
    </div>
  `;
});

export function mountPanel(mount: HTMLElement, config: SurfaceConfig): void {
  html`${AgentPanel({ config })}`.mount(mount);
}
