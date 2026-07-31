/**
 * The demo's wallet + panel, shared by every surface on the site.
 *
 * Everything in the [WALLET] section belongs in a browser extension — it holds
 * the user key and renders the trust-critical dialogs. It lives in the page
 * here only so the demo needs nothing installed. The [SURFACE] section is what
 * a real website would actually write, and it is deliberately tiny.
 */

import {
  AgentWallet,
  createWalletProvider,
  installProvider,
  ProviderRejected,
  type AgentConnectRequest,
  type AgentProvider,
  type AgentSession,
  type ApprovalPrompt,
  type SiteTool,
} from '@agentport/client';
import { generateKeyPair, type AgentSummary } from '@agentport/protocol';

export type { SiteTool };

const relayUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;

// ---------------------------------------------------------------------------
// [WALLET] key custody
// ---------------------------------------------------------------------------

function devUserKey(): string {
  const stored = localStorage.getItem('agentport.dev.userkey');
  if (stored) return stored;
  const keys = generateKeyPair();
  localStorage.setItem('agentport.dev.userkey', keys.secretKey);
  return keys.secretKey;
}

// ---------------------------------------------------------------------------
// [WALLET] dialogs, rendered in a shadow root so page CSS can't restyle a
// security prompt into something misleading.
// ---------------------------------------------------------------------------

const DIALOG_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
.back { position: fixed; inset: 0; background: rgba(6,8,11,.72); display: grid; place-items: center; z-index: 2147483647; }
.card { width: min(430px, 92vw); background: #14171c; color: #e6e8ec; border: 1px solid #262c36; border-radius: 16px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,.5); }
.body { padding: 22px 24px; }
h3 { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
p.sub { margin: 0 0 18px; color: #8b94a3; font-size: 13px; line-height: 1.5; }
.foot { display: flex; gap: 8px; justify-content: flex-end; padding: 14px 24px; border-top: 1px solid #222831; background: #101318; }
button { font: inherit; font-size: 14px; font-weight: 600; border: 0; border-radius: 9px; padding: 9px 16px; cursor: pointer; background: #7c9cff; color: #0d0f12; }
button.ghost { background: transparent; border: 1px solid #2b323d; color: #e6e8ec; font-weight: 500; }
button:disabled { opacity: .4; cursor: default; }
.row { display: flex; gap: 11px; align-items: center; width: 100%; text-align: left; background: transparent; border: 1px solid #262c36; border-radius: 11px; padding: 13px; margin-bottom: 8px; color: #e6e8ec; font-weight: 500; cursor: pointer; }
.row[data-sel="1"] { border-color: #7c9cff; background: #171b26; }
.row small { display: block; color: #8b94a3; font-weight: 400; font-size: 12px; margin-top: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #47505f; flex: none; }
.dot.on { background: #4fd18b; box-shadow: 0 0 0 3px rgba(79,209,139,.16); }
.label { font-size: 11px; letter-spacing: .7px; text-transform: uppercase; color: #7d8798; margin: 0 0 7px; }
ul { list-style: none; margin: 0 0 16px; padding: 0; font-size: 13px; }
li { padding: 3px 0; display: flex; gap: 8px; }
li::before { content: "✓"; color: #4fd18b; }
li.ask::before { content: "!"; color: #ffb454; }
li.none { color: #7d8798; }
li.none::before { content: "–"; color: #7d8798; }
code { font-family: ui-monospace, monospace; font-size: 12px; color: #9aa4b4; word-break: break-all; display: block; background: #0d0f12; border: 1px solid #222831; border-radius: 8px; padding: 9px; }
input { width: 100%; background: #0d0f12; border: 1px solid #262c36; border-radius: 9px; padding: 10px 12px; color: #e6e8ec; font: inherit; font-size: 15px; letter-spacing: 1px; outline: none; }
input:focus { border-color: #7c9cff; }
.note { color: #8b94a3; font-size: 12px; margin-top: 12px; min-height: 16px; }
`;

function modal(render: (root: ShadowRoot, done: (value: unknown) => void) => void): Promise<unknown> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = DIALOG_CSS;
  root.append(style);

  return new Promise((resolve) => {
    render(root, (value) => {
      host.remove();
      resolve(value);
    });
  });
}

function shell(root: ShadowRoot, inner: string, confirmLabel: string, cancelLabel: string): {
  back: HTMLElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
  q: <T extends HTMLElement>(sel: string) => T;
} {
  const back = document.createElement('div');
  back.className = 'back';
  back.innerHTML = `<div class="card"><div class="body">${inner}</div>
    <div class="foot"><button class="ghost" data-cancel>${cancelLabel}</button>
    <button data-ok>${confirmLabel}</button></div></div>`;
  root.append(back);
  const q = <T extends HTMLElement>(sel: string) => back.querySelector(sel) as T;
  return { back, ok: q<HTMLButtonElement>('[data-ok]'), cancel: q<HTMLButtonElement>('[data-cancel]'), q };
}

async function chooseAgent(agents: AgentSummary[]): Promise<AgentSummary | null> {
  return (await modal((root, done) => {
    const rows = agents
      .map(
        (agent, index) => `<button class="row" data-i="${index}" ${agent.online ? '' : 'disabled'}>
        <span class="dot ${agent.online ? 'on' : ''}"></span>
        <span>${agent.name}<small>${agent.runtime} · ${agent.location ?? 'unknown'} · ${
          agent.online ? 'Online' : 'Offline'
        }</small></span></button>`,
      )
      .join('');
    const { ok, cancel, q, back } = shell(
      root,
      `<h3>Choose an agent</h3><p class="sub">These are agents you own. The site only ever sees the one you pick — never your key, your model, or your other tools.</p>${rows}`,
      'Continue',
      'Cancel',
    );
    ok.disabled = true;
    let selected: AgentSummary | null = null;
    for (const row of back.querySelectorAll<HTMLButtonElement>('.row')) {
      row.addEventListener('click', () => {
        for (const other of back.querySelectorAll('.row')) other.removeAttribute('data-sel');
        row.setAttribute('data-sel', '1');
        selected = agents[Number(row.dataset.i)] ?? null;
        ok.disabled = !selected;
      });
    }
    void q;
    ok.addEventListener('click', () => done(selected));
    cancel.addEventListener('click', () => done(null));
  })) as AgentSummary | null;
}

async function confirmGrant(agent: AgentSummary, request: AgentConnectRequest): Promise<boolean> {
  const ask = new Set(request.alwaysAsk ?? []);
  const allowed = request.tools.filter((tool) => !ask.has(tool.name) && !tool.requiresApproval);
  const gated = request.tools.filter((tool) => ask.has(tool.name) || tool.requiresApproval);
  const list = (tools: typeof request.tools, cls: string) =>
    tools.length
      ? tools.map((tool) => `<li class="${cls}">${tool.description}</li>`).join('')
      : '<li class="none">nothing</li>';

  return (await modal((root, done) => {
    const { ok, cancel } = shell(
      root,
      `<h3>${request.name} wants to use ${agent.name}</h3>
       <p class="sub">These capabilities exist only while this tab is connected. Closing it takes them away.</p>
       <p class="label">Allowed for this session</p><ul>${list(allowed, '')}</ul>
       <p class="label">Always ask first</p><ul>${list(gated, 'ask')}</ul>`,
      'Connect',
      'Deny',
    );
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
  })) as boolean;
}

async function decide(prompt: ApprovalPrompt): Promise<boolean> {
  return (await modal((root, done) => {
    const args = prompt.call ? JSON.stringify(prompt.call.arguments, null, 1).slice(0, 400) : '';
    const { ok, cancel } = shell(
      root,
      `<h3>Approve this action?</h3><p class="sub">${prompt.summary}</p>${
        prompt.call ? `<code>${prompt.call.name}\n${args}</code>` : ''
      }`,
      'Allow',
      'Decline',
    );
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
  })) as boolean;
}

export async function pairDialog(wallet: AgentWallet, prefill = ''): Promise<boolean> {
  return (await modal((root, done) => {
    const { ok, cancel, q } = shell(
      root,
      `<h3>Pair a new agent</h3>
       <p class="sub">On your own machine run <code style="display:inline;background:none;border:0;padding:0">npm run daemon</code> and paste the code it prints.</p>
       <input placeholder="R7KP-92MX" value="${prefill}" />
       <p class="note"></p>`,
      'Pair',
      'Cancel',
    );
    const input = q<HTMLInputElement>('input');
    const note = q<HTMLElement>('.note');
    input.focus();
    ok.addEventListener('click', async () => {
      const code = input.value.trim().toUpperCase();
      if (!code) return;
      ok.disabled = true;
      note.textContent = 'looking up…';
      try {
        const offer = await wallet.claimPairing(code);
        note.textContent = `Found ${offer.agent.name}. Signing ownership cert…`;
        await wallet.approvePairing(offer);
        done(true);
      } catch (err) {
        note.textContent = `failed: ${(err as Error).message}`;
        ok.disabled = false;
      }
    });
    cancel.addEventListener('click', () => done(false));
  })) as boolean;
}

// ---------------------------------------------------------------------------
// [SURFACE] the conversation panel
// ---------------------------------------------------------------------------

export interface SurfaceConfig {
  name: string;
  route?: string;
  context?: Record<string, unknown>;
  tools: SiteTool[];
  alwaysAsk?: string[];
  placeholder?: string;
  /** Suggested prompts shown before the first message. */
  suggestions?: string[];
}

export async function mountPanel(mount: HTMLElement, config: SurfaceConfig): Promise<void> {
  mount.innerHTML = `
    <div class="ap-head"><span>Agent</span><span class="ap-status">not connected</span></div>
    <div class="ap-empty">
      <p class="ap-pitch">Bring your own agent.<br/>This site never sees your model, keys, or memory.</p>
      <button class="ap-connect">Connect agent</button>
      <p class="ap-alt"><button class="ap-pair">Pair a new agent</button></p>
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

  const wallet = new AgentWallet({ relayUrl, userSecretKey: devUserKey() });
  const provider: AgentProvider = createWalletProvider(wallet, { chooseAgent, confirmGrant, decide });
  installProvider(provider);
  await wallet.connect();
  status.textContent = 'wallet ready';

  let session: AgentSession | null = null;

  const attach = (next: AgentSession) => {
    session = next;
    empty.style.display = 'none';
    log.classList.add('live');
    form.classList.add('live');
    status.textContent = `${next.info.agentName} · ${next.info.runtime}`;
    status.classList.add('online');
    line('meta', `connected · ${next.grant.tools.length} tools lent · expires ${new Date(next.grant.expiresAt).toLocaleTimeString()}`);
    if (config.suggestions?.length) line('meta', `try: ${config.suggestions.join(' · ')}`);

    let current: HTMLElement | null = null;
    next.on('delta', (event) => {
      if (!current) current = line('agent', '');
      current.textContent += event.text;
      log.scrollTop = log.scrollHeight;
    });
    next.on('thought', (event) => line('meta', event.text.trim().slice(0, 200)));
    next.on('tool', (event) => line(`tool ${event.ok ? 'ok' : 'err'}`, event.name + (event.ok ? '' : ` — ${event.error}`)));
    next.on('done', () => {
      current = null;
    });
    next.on('closed', (event) => {
      line('meta', `session closed (${event.reason})`);
      status.textContent = 'disconnected';
      status.classList.remove('online');
      form.classList.remove('live');
      session = null;
    });
  };

  const connect = async () => {
    // [SURFACE] This is the entire integration a website writes.
    try {
      attach(
        await navigator.agent.connect({
          name: config.name,
          route: config.route,
          context: config.context,
          tools: config.tools,
          alwaysAsk: config.alwaysAsk,
        }),
      );
    } catch (err) {
      if (err instanceof ProviderRejected && err.reason === 'no_agents') {
        if (await pairDialog(wallet)) return connect();
        return;
      }
      if (!(err instanceof ProviderRejected)) line('meta', `connect failed: ${(err as Error).message}`);
    }
  };

  q('.ap-connect').addEventListener('click', () => void connect());
  q('.ap-pair').addEventListener('click', () => void pairDialog(wallet));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !session) return;
    input.value = '';
    line('user', text);
    session.prompt(text).catch((err: Error) => line('meta', `error: ${err.message}`));
  });

  const hashCode = /code=([A-Z2-9-]+)/i.exec(location.hash)?.[1];
  if (hashCode) void pairDialog(wallet, hashCode.toUpperCase());
}

declare global {
  interface Navigator {
    agent: AgentProvider;
  }
}
