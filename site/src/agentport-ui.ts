/**
 * The demo's agent panel.
 *
 * Note what is no longer here: no key, no `AgentWallet`, no picker, no consent
 * screen. Those moved to where the user's key actually is — an extension, or
 * their terminal via `connect.js`. This file is now an honest example of what
 * a *site* writes, and nothing more.
 */

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

export function mountPanel(mount: HTMLElement, config: SurfaceConfig): void {
  mount.innerHTML = `
    <div class="ap-head"><span>Agent</span><span class="ap-status">not connected</span></div>
    <div class="ap-empty">
      <p class="ap-pitch">Bring your own agent.<br/>This site never sees your model, keys, or memory.</p>
      <button class="ap-connect">Connect agent</button>
      <p class="ap-alt" style="color:var(--muted);font-size:12px">No install. Your agent approves from wherever it runs.</p>
    </div>
    <div class="ap-log"></div>
    <form class="ap-form"><input placeholder="${config.placeholder ?? 'Ask your agent…'}" autocomplete="off"/><button>Send</button></form>`;

  const q = <T extends HTMLElement>(sel: string) => mount.querySelector(sel) as T;
  const status = q('.ap-status');
  const empty = q('.ap-empty');
  const log = q('.ap-log');
  const form = q<HTMLFormElement>('.ap-form');
  const input = q<HTMLInputElement>('.ap-form input');

  const line = (kind: string, text: string) => {
    const div = document.createElement('div');
    div.className = `ap-msg ${kind}`;
    div.textContent = text;
    log.append(div);
    log.scrollTop = log.scrollHeight;
    return div;
  };

  let session: AgentSession | null = null;

  const attach = (next: AgentSession) => {
    session = next;
    empty.style.display = 'none';
    log.classList.add('live');
    form.classList.add('live');
    status.textContent = `${next.info.agentName} · ${next.info.runtime}`;
    status.classList.add('online');
    line(
      'meta',
      `connected · ${next.grant.tools.length} tools lent · expires ${new Date(next.grant.expiresAt).toLocaleTimeString()}`,
    );
    if (config.suggestions?.length) line('meta', `try: ${config.suggestions.join(' · ')}`);

    let current: HTMLElement | null = null;
    next.on('delta', (event) => {
      if (!current) current = line('agent', '');
      current.textContent += event.text;
      log.scrollTop = log.scrollHeight;
    });
    next.on('thought', (event) => line('meta', event.text.trim().slice(0, 200)));
    next.on('tool', (event) =>
      line(`tool ${event.ok ? 'ok' : 'err'}`, event.name + (event.ok ? '' : ` — ${event.error}`)),
    );
    next.on('done', () => {
      current = null;
    });
    next.on('closed', (event) => {
      line('meta', `session closed (${event.reason})`);
      status.textContent = 'disconnected';
      status.classList.remove('online');
      form.classList.remove('live');
      empty.style.display = '';
      session = null;
    });
  };

  q('.ap-connect').addEventListener('click', () => {
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
        if (!/cancelled/i.test(err.message)) line('meta', `connect failed: ${err.message}`);
      });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !session) return;
    input.value = '';
    line('user', text);
    session.prompt(text).catch((err: Error) => line('meta', `error: ${err.message}`));
  });
}
