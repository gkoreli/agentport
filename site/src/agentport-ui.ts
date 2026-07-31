/**
 * The demo's agent panel, in nisli.
 *
 * Note what is no longer here: no key, no `AgentWallet`, no picker, no consent
 * screen. Those moved to where the user's key actually is — an extension, or
 * their terminal via `connect.js`. This file is an honest example of what a
 * *site* writes, and nothing more.
 *
 * This is our own page rather than an injected surface, so `component()` is
 * safe here; the injected modal deliberately avoids it (see modal.ts).
 */

import { component, computed, each, html, signal, when, type ReadonlySignal } from '@nisli/core';
import AgentPortConnect from './connect.js';
import type { AgentSession, SiteTool } from '@agentport/client';

export type { SiteTool };

export interface SurfaceConfig {
  name: string;
  route?: string;
  context?: Record<string, unknown>;
  tools: SiteTool[];
  alwaysAsk?: string[];
  placeholder?: string;
  suggestions?: string[];
}

interface Line {
  id: number;
  kind: string;
  text: string;
}

const AgentPanel = component<{ config: SurfaceConfig }>('agent-panel', (props) => {
  // nisli props are signals — `props.config` is Signal<SurfaceConfig>, not the
  // object. Casting instead of reading `.value` silently yields undefined
  // fields, which is exactly how the connect button died quietly once already.
  const config = props.config.value;

  const lines = signal<Line[]>([]);
  const status = signal('not connected');
  const online = signal(false);
  const live = signal(false);
  const draft = signal('');

  let session: AgentSession | null = null;
  let nextId = 0;

  // PROVENANCE. The site stores no transcript at all — not in localStorage,
  // not in sessionStorage, nowhere. On reload the panel re-attaches to the
  // session and asks the AGENT for the conversation, which lives in the
  // user's own agent session store on their own machine. The relay stores
  // none of it either.

  const push = (kind: string, text: string): number => {
    const id = nextId++;
    lines.value = [...lines.value, { id, kind, text }];
    return id;
  };

  const appendTo = (id: number, text: string) => {
    lines.value = lines.value.map((line) => (line.id === id ? { ...line, text: line.text + text } : line));
  };

  const attach = (next: AgentSession) => {
    session = next;
    live.value = true;
    online.value = true;
    status.value = `${next.info.agentName} · ${next.info.runtime}`;
    push(
      'meta',
      `connected · ${next.grant.tools.length} tools lent · expires ${new Date(
        next.grant.expiresAt,
      ).toLocaleTimeString()}`,
    );
    if (config.suggestions?.length) push('meta', `try: ${config.suggestions.join(' · ')}`);

    let current: number | null = null;
    next.on('delta', (event) => {
      if (current === null) current = push('agent', '');
      appendTo(current, event.text);
    });
    next.on('thought', (event) => push('meta', event.text.trim().slice(0, 200)));
    next.on('tool', (event) =>
      push(`tool ${event.ok ? 'ok' : 'err'}`, event.name + (event.ok ? '' : ` — ${event.error}`)),
    );
    next.on('done', () => {
      current = null;
    });
    next.on('closed', (event) => {
      push('meta', `session closed (${event.reason})`);
      status.value = 'disconnected';
      online.value = false;
      live.value = false;
      session = null;
    });
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
      const roles: Record<string, string> = {
        user: 'user',
        agent: 'agent',
        thought: 'meta',
        tool: 'tool ok',
        approval: 'meta',
      };
      lines.value = history.map((entry, index) => ({
        id: index,
        kind: roles[entry.role] ?? 'meta',
        text: entry.text,
      }));
      nextId = history.length;
      push('meta', `reconnected · ${history.length} message(s) restored from your agent`);
    } catch (err) {
      console.error('[agentport] resume failed', err);
      push('error', `could not reconnect: ${(err as Error).message}`);
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
        push('error', `connect failed: ${err.message}`);
      });
  };

  const send = () => {
    const text = draft.value.trim();
    if (!text || !session) return;
    draft.value = '';
    push('user', text);
    session.prompt(text).catch((err: Error) => {
      console.error('[agentport] prompt failed', err);
      push('error', err.message);
    });
  };

  return html`
    <div class="ap-head">
      <span>Agent</span><span class="ap-status" class:online=${online}>${status}</span>
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

    <div class="ap-log" class:live=${computed(() => live.value || lines.value.length > 0)}>
      ${each(
        lines as ReadonlySignal<Line[]>,
        (line) => line.id,
        (line) =>
          html`<div class=${computed(() => `ap-msg ${line.value.kind}`)}>
            ${computed(() => line.value.text)}
          </div>`,
      )}
    </div>

    <form class="ap-form" class:live=${live} @submit.prevent=${send}>
      <input
        placeholder=${config.placeholder ?? 'Ask your agent…'}
        autocomplete="off"
        .value=${draft}
        @input=${(event: Event) => (draft.value = (event.target as HTMLInputElement).value)}
      />
      <button>Send</button>
    </form>
  `;
});

export function mountPanel(mount: HTMLElement, config: SurfaceConfig): void {
  html`${AgentPanel({ config })}`.mount(mount);
}
