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

import { component, each, html, signal, when, type ReadonlySignal } from '@nisli/core';
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
  const config = props.config as unknown as SurfaceConfig;

  const lines = signal<Line[]>([]);
  const status = signal('not connected');
  const online = signal(false);
  const live = signal(false);
  const draft = signal('');

  let session: AgentSession | null = null;
  let nextId = 0;

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
        if (!/cancelled/i.test(err.message)) push('meta', `connect failed: ${err.message}`);
      });
  };

  const send = (event: Event) => {
    event.preventDefault();
    const text = draft.value.trim();
    if (!text || !session) return;
    draft.value = '';
    push('user', text);
    session.prompt(text).catch((err: Error) => push('meta', `error: ${err.message}`));
  };

  return html`
    <div class="ap-head">
      <span>Agent</span><span class="ap-status" class:online=${online}>${status}</span>
    </div>

    ${when(
      () => !live.value,
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

    <div class="ap-log" class:live=${live}>
      ${each(
        lines as ReadonlySignal<Line[]>,
        (line) => line.id,
        (line) => html`<div class="ap-msg ${() => line.value.kind}">${() => line.value.text}</div>`,
      )}
    </div>

    <form class="ap-form" class:live=${live} @submit=${send}>
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
