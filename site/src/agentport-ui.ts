declare const __AGENTPORT_VERSION__: string | undefined;

/** Baked in by site/build.ts; 'dev' under tsx/test runners with no define. */
const VERSION = typeof __AGENTPORT_VERSION__ === 'string' ? __AGENTPORT_VERSION__ : 'dev';

/**
 * The demo's agent panel, rendered by the protocol-neutral Nisli chat set.
 *
 * Note what is no longer here: no key, no `AgentWallet`, no picker, no consent
 * screen. Those moved to where the user's key actually is — an extension, the
 * hosted wallet's own origin, or their terminal in the universal fallback.
 * This file is an honest example of what a *site* writes, and nothing more.
 *
 * The panel consumes the same AG-UI event stream a third-party renderer would,
 * then translates it once into the protocol-neutral semantic updates owned by
 * the chat store. Transport vocabulary stops at that boundary; the components
 * only know messages, reasoning, tools, and runs.
 *
 * Styling comes from the chat set's `data-slot` contract. The copied source
 * carries utility classes for projects that build them, but this demo keeps
 * its own small token-driven stylesheet and no Tailwind pipeline.
 *
 * This is our own page rather than an injected surface, so `component()` is
 * safe here; the injected modal deliberately avoids it (see modal.ts).
 */

import { component, computed, each, html, onCleanup, signal, when } from '@nisli/core';
import AgentPortConnect from './connect.js';
import { aguiStream, type AguiAdapter, type AguiEvent } from '@agentport/agui';
import type { AgentSessionHandle, ApprovalPrompt, SessionEvents, SiteTool } from '@agentport/client';
import { toErr, type HistoryEntry } from '@agentport/protocol';
import { Chat, createChatStore, type ChatController } from '../../src/nisli-ui/ui/chat/index.js';
import { siteLogger } from './observe.js';

const log = siteLogger.child('panel');

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
   * composed itself (e.g. inkwell's annotations). The prompt enters the same
   * busy-aware queue as composer input. Returns false when unavailable.
   */
  bind?: (panel: PanelApi) => void;
}

export interface PanelApi {
  send(text: string): boolean;
  get live(): boolean;
}

const text = (value: string) => ({ type: 'text' as const, text: value });

function displayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}


const AgentPanel = component<{ config: SurfaceConfig }>('agent-panel', (props) => {
  // nisli props are signals — `props.config` is Signal<SurfaceConfig>, not the
  // object. Casting instead of reading `.value` silently yields undefined
  // fields, which is exactly how the connect button died quietly once already.
  const config = props.config.value;

  const chat = createChatStore();
  const status = signal('not connected');
  const online = signal(false);
  const live = signal(false);
  const busy = signal(false);
  const notice = signal('');

  let session: AgentSessionHandle | null = null;
  let adapter: AguiAdapter | null = null;
  let eventIterator: AsyncIterator<AguiEvent> | null = null;
  let chatController: ChatController | null = null;
  let toolSeq = 0;
  let currentRunId: string | null = null;
  let attachmentEpoch = 0;
  let disposed = false;
  let approvalCardSeq = 0;

  // PROVENANCE. The site stores no transcript at all — not in localStorage,
  // not in sessionStorage, nowhere. On reload the panel re-attaches to the
  // session and asks the AGENT for the conversation, which lives in the
  // user's own agent session store on their own machine. The relay stores
  // none of it either.

  /**
   * The panel consumes the session through @agentport/agui (ADR-017) — the
   * same event stream any third-party AG-UI renderer would get, so the demo
   * itself proves the adapter. The switch below is the only protocol boundary
   * in the view: it produces semantic chat updates and never leaks wire event
   * names into the reusable components. Extension approvals arrive already
   * decided in trusted browser chrome; hosted-wallet delegations route
   * approvals to this page, so the decider below renders a real card and the
   * resulting event becomes the settled row.
   */
  const applyEvent = (event: AguiEvent): void => {
    switch (event.type) {
        case 'RUN_STARTED':
          chat.apply({ type: 'run.start' });
          busy.value = true;
          notice.value = '';
          currentRunId = event.runId;
          return;
        case 'TEXT_MESSAGE_START':
          chat.apply({ type: 'message.start', id: event.messageId, role: 'assistant' });
          return;
        case 'TEXT_MESSAGE_CONTENT':
          chat.apply({ type: 'message.delta', id: event.messageId, content: text(event.delta) });
          return;
        case 'TEXT_MESSAGE_END':
          chat.apply({ type: 'message.end', id: event.messageId });
          return;
        case 'REASONING_START':
          chat.apply({ type: 'reasoning.start', id: event.messageId });
          return;
        case 'REASONING_MESSAGE_CONTENT':
          chat.apply({ type: 'reasoning.delta', id: event.messageId, content: text(event.delta) });
          return;
        case 'REASONING_END':
          chat.apply({ type: 'reasoning.end', id: event.messageId });
          return;
        case 'TOOL_CALL_START':
          chat.apply({ type: 'tool.start', id: event.toolCallId, name: event.toolCallName });
          return;
        case 'TOOL_CALL_ARGS':
          chat.apply({ type: 'tool.input', id: event.toolCallId, input: event.delta });
          return;
        case 'TOOL_CALL_END':
          // The call is settled here; what it returned arrives next, exactly as
          // a third-party AG-UI renderer would see it.
          chat.apply({ type: 'tool.end', id: event.toolCallId });
          return;
        case 'TOOL_CALL_RESULT': {
          // `content` is the spec field every renderer reads. rawEvent carries
          // the AgentPort outcome because AG-UI has no success flag on a result.
          const call = event.rawEvent as SessionEvents['tool'];
          chat.apply({
            type: 'tool.end',
            id: event.toolCallId,
            status: call.ok ? 'complete' : 'error',
            output: event.content === '' ? undefined : [text(event.content)],
            error: call.ok ? undefined : (call.error ?? 'Tool call failed'),
          });
          return;
        }
        case 'RUN_FINISHED':
          chat.apply({ type: 'run.end' });
          currentRunId = null;
          busy.value = false;
          return;
        case 'RUN_ERROR':
          chat.apply({ type: 'run.error', error: event.message });
          currentRunId = null;
          busy.value = false;
          notice.value = event.message;
          return;
        case 'CUSTOM':
          if (event.name === 'agentport.approval') {
            const approval = event.value;
            const id = `approval-${toolSeq++}`;
            chat.apply({
              type: 'tool.start',
              id,
              name: approval.summary,
              input: approval.call?.arguments === undefined
                ? undefined
                : displayJson(approval.call.arguments),
            });
            chat.apply({ type: 'tool.end', id, status: approval.granted ? 'complete' : 'cancelled' });
          } else if (event.name === 'agentport.closed') {
            for (const approval of pendingApprovals.value) approval.resolve(false);
            pendingApprovals.value = [];
            notice.value = `session closed (${event.value.reason})`;
            status.value = 'disconnected';
            online.value = false;
            live.value = false;
            busy.value = false;
            session = null;
            adapter = null;
            currentRunId = null;
            chat.reset();
          }
          return;
        default:
          return;
    }
  };

  const consume = async (events: AsyncIterator<AguiEvent>): Promise<void> => {
    try {
      while (true) {
        const next = await events.next();
        if (next.done || eventIterator !== events) return;
        applyEvent(next.value);
      }
    } catch (error) {
      if (eventIterator !== events) return;
      const message = error instanceof Error ? error.message : String(error);
      chat.apply({ type: 'run.error', error: message });
      busy.value = false;
      notice.value = `event stream failed: ${message}`;
    }
  };

  interface PendingApproval {
    id: number;
    prompt: ApprovalPrompt;
    resolve: (granted: boolean) => void;
  }
  const pendingApprovals = signal<PendingApproval[]>([]);

  /** Delegated sessions route approvals here; the card IS the consent UI. */
  const decide = (prompt: ApprovalPrompt): Promise<boolean> =>
    new Promise((resolve) => {
      pendingApprovals.value = [...pendingApprovals.value, { id: ++approvalCardSeq, prompt, resolve }];
    });

  const settleApproval = (id: number, granted: boolean) => {
    const approval = pendingApprovals.value.find((candidate) => candidate.id === id);
    if (!approval) return;
    pendingApprovals.value = pendingApprovals.value.filter((candidate) => candidate.id !== id);
    approval.resolve(granted);
  };

  const detachEvents = (): void => {
    const previous = eventIterator;
    eventIterator = null;
    adapter = null;
    void previous?.return?.();
    // A dead attachment must not leave a consent question hanging: unanswered
    // approvals fail closed.
    for (const approval of pendingApprovals.value) approval.resolve(false);
    pendingApprovals.value = [];
  };

  const attach = (next: AgentSessionHandle): void => {
    detachEvents();
    chat.reset();
    toolSeq = 0;
    currentRunId = null;
    busy.value = false;
    session = next;
    adapter = aguiStream(next);
    eventIterator = adapter.events[Symbol.asyncIterator]();
    live.value = true;
    online.value = true;
    status.value = `${next.info.agentName} · ${next.info.runtime}`;
    notice.value = `connected · ${next.grant.tools.length} tools lent · expires ${new Date(
      next.grant.expiresAt,
    ).toLocaleTimeString()}`;
    void consume(eventIterator);
  };

  /** Replay the agent's own history through the reducer, one settled entry each. */
  const seed = (history: HistoryEntry[]) => {
    chat.reset();
    for (const entry of history) {
      switch (entry.role) {
        case 'user':
          chat.addUserMessage(entry.text);
          break;
        case 'agent':
          {
            const id = `history-${toolSeq++}`;
            chat.apply({ type: 'message.start', id, role: 'assistant' });
            chat.apply({ type: 'message.delta', id, content: text(entry.text) });
            chat.apply({ type: 'message.end', id });
          }
          break;
        case 'thought':
          {
            const id = `history-${toolSeq++}`;
            chat.apply({ type: 'reasoning.start', id });
            chat.apply({ type: 'reasoning.delta', id, content: text(entry.text) });
            chat.apply({ type: 'reasoning.end', id });
          }
          break;
        default:
          {
            // Tool / approval history rows arrive as flat text.
            const id = `history-${toolSeq++}`;
            chat.apply({ type: 'tool.start', id, name: entry.text });
            chat.apply({ type: 'tool.end', id, status: 'complete' });
          }
      }
    }
    chat.apply({ type: 'run.end' });
  };

  /**
   * A refresh should not throw away a live agent. Re-attach and hydrate from
   * the agent before exposing the session; if it is gone, fall back to the
   * ordinary Connect button.
   */
  const restore = async () => {
    const attempt = ++attachmentEpoch;
    let resumedSession: AgentSessionHandle | null = null;
    try {
      const resumed = await AgentPortConnect.resume({
        name: config.name,
        route: config.route,
        context: config.context,
        tools: config.tools,
        alwaysAsk: config.alwaysAsk,
        decide,
      });
      if (!resumed) return;
      resumedSession = resumed.session;

      // Hydrate from the agent's own store rather than from anything we kept.
      const history = await resumedSession.history();
      if (disposed || attempt !== attachmentEpoch) {
        resumedSession.close('superseded');
        return;
      }
      attach(resumedSession);
      seed(history);
      notice.value = `reconnected · ${history.length} message(s) restored from your agent`;
    } catch (err) {
      resumedSession?.close('resume_failed');
      if (attempt !== attachmentEpoch) return;
      log.error('resume failed', { err, data: { surface: config.name } });
      notice.value = `could not reconnect: ${toErr(err).message}`;
    }
  };
  void restore();

  const connect = () => {
    const attempt = ++attachmentEpoch;
    // [SURFACE] The entire integration. An installed wallet is used if present;
    // otherwise the hosted wallet delegates, with the code flow as fallback.
    AgentPortConnect.connect({
      name: config.name,
      route: config.route,
      context: config.context,
      tools: config.tools,
      alwaysAsk: config.alwaysAsk,
      decide,
    })
      .then((next) => {
        if (disposed || attempt !== attachmentEpoch) {
          next.close('superseded');
          return;
        }
        attach(next);
      })
      .catch((err: Error) => {
        if (attempt !== attachmentEpoch) return;
        // A user dismissing the dialog is not an error. Anything else is, and
        // it goes both on screen and to the console — the previous version put
        // it in a hidden element, which is how a thrown TypeError looked
        // exactly like the button doing nothing.
        if (/cancelled/i.test(err.message)) return;
        log.error('connect failed', { err, data: { surface: config.name } });
        notice.value = `connect failed: ${err.message}`;
      });
  };

  onCleanup(() => {
    disposed = true;
    attachmentEpoch += 1;
    detachEvents();
    chatController = null;
  });

  const onPrompt = (prompt: string): boolean => {
    if (!session || !adapter || busy.value) return false;
    chat.addUserMessage(prompt);
    busy.value = true;
    // The AG-UI adapter owns run lifecycle events, including failures.
    adapter.run(prompt).catch((err: Error) => {
      log.error('prompt failed', { sessionId: session?.id, err, data: { surface: config.name } });
    });
    return true;
  };

  config.bind?.({
    send: (prompt) => live.value && chatController?.send(prompt) === true,
    get live() {
      return live.value;
    },
  });

  const onCancel = () => {
    if (adapter && currentRunId) adapter.cancel(currentRunId);
  };

  const empty = 'Ask your agent something.';

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
          <p class="ap-alt">No install. Approve in your wallet popup, or use a connect code.</p>
        </div>
      `,
    )}

    <div class="ap-chat" class:live=${live}>
      ${when(
        computed(() => notice.value !== ''),
        () => html`<div class="ap-notice">${notice}</div>`,
      )}
      ${each(
        pendingApprovals,
        (approval) => approval.id,
        (approval) => {
          const summary = computed(() => approval.value.prompt.summary);
          const toolName = computed(() => approval.value.prompt.call?.name ?? 'Agent request');
          const hasArguments = computed(() => approval.value.prompt.call !== undefined);
          const argumentsText = computed(() => JSON.stringify(approval.value.prompt.call?.arguments ?? {}, null, 2));
          return html`<section class="ap-approval" aria-live="polite">
            <div class="ap-approval-label">Approval required</div>
            <strong>${summary}</strong>
            <span class="ap-approval-tool">${toolName}</span>
            ${when(hasArguments, () => html`<pre>${argumentsText}</pre>`)}
            <div class="ap-approval-actions">
              <button class="deny" @click=${() => settleApproval(approval.value.id, false)}>Deny</button>
              <button @click=${() => settleApproval(approval.value.id, true)}>Allow</button>
            </div>
          </section>`;
        },
      )}
      ${Chat({
        entries: chat.entries,
        onPrompt,
        onCancel,
        busy,
        empty,
        suggestions: config.suggestions,
        bind: (controller) => {
          chatController = controller;
        },
        placeholder: config.placeholder ?? 'Ask your agent…',
      })}
    </div>
  `;
});

export function mountPanel(mount: HTMLElement, config: SurfaceConfig): void {
  html`${AgentPanel({ config })}`.mount(mount);
}
