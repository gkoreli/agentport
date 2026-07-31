/**
 * connect.js — the drop-in.
 *
 * A site adds one script tag and gets `AgentPort.connect()`. That's the whole
 * integration, in the same spirit as embedding Stripe/Link: the merchant page
 * renders a component and never touches the sensitive material.
 *
 * The load-bearing property is what this file *cannot* do. It holds an
 * ephemeral keypair minted per page load, so:
 *
 *   - it cannot list the user's agents
 *   - it cannot open a session with any of them
 *   - it cannot approve anything
 *
 * All it can do is publish a request and render the code that carries it to
 * wherever the user's key actually lives. The consent — connection *and* every
 * gated tool call — happens there. The widget renders; it never decides.
 */

import {
  AgentWallet,
  type AgentConnectRequest,
  type AgentProvider,
  type AgentSession,
} from '@agentport/client';
import { generateKeyPair } from '@agentport/protocol';

function relayUrl(): string {
  const configured = document.currentScript?.getAttribute('data-relay');
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
}

const RELAY = relayUrl();

// ---------------------------------------------------------------------------
// The modal. Closed shadow root so the embedding page cannot read or restyle
// what the user is being shown.
// ---------------------------------------------------------------------------

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
.back { position: fixed; inset: 0; background: rgba(6,8,11,.74); display: grid; place-items: center; z-index: 2147483647; }
.card { width: min(430px, 92vw); background: #14171c; color: #e6e8ec; border: 1px solid #262c36; border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden; }
.body { padding: 24px; text-align: center; }
h3 { margin: 0 0 6px; font-size: 16px; font-weight: 650; }
p { margin: 0 0 18px; color: #8b94a3; font-size: 13px; line-height: 1.55; }
.code { font-family: ui-monospace, monospace; font-size: 30px; letter-spacing: 5px; font-weight: 600; background: #0d0f12; border: 1px solid #262c36; border-radius: 12px; padding: 16px; cursor: pointer; user-select: all; }
.code:hover { border-color: #7c9cff; }
.hint { font-size: 12px; margin: 12px 0 0; color: #6f7889; }
.status { margin: 16px 0 0; font-size: 13px; color: #8b94a3; min-height: 18px; }
.status.err { color: #ff8080; }
.foot { display: flex; justify-content: space-between; align-items: center; padding: 13px 20px; border-top: 1px solid #222831; background: #101318; }
.brand { font-size: 11px; color: #6f7889; letter-spacing: .3px; }
button { font: inherit; font-size: 13px; font-weight: 500; border: 1px solid #2b323d; background: transparent; color: #e6e8ec; border-radius: 8px; padding: 7px 14px; cursor: pointer; }
.spin { display: inline-block; width: 11px; height: 11px; border: 2px solid #2f3846; border-top-color: #7c9cff; border-radius: 50%; animation: s .8s linear infinite; vertical-align: -1px; margin-right: 7px; }
@keyframes s { to { transform: rotate(360deg); } }
`;

interface Modal {
  status(text: string, error?: boolean): void;
  close(): void;
  cancelled: Promise<never>;
}

function openModal(code: string, surfaceName: string): Modal {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;

  const back = document.createElement('div');
  back.className = 'back';
  back.innerHTML = `<div class="card">
    <div class="body">
      <h3>Connect your agent</h3>
      <p>Paste this code where your agent is running. ${surfaceName} never sees your key, your model, or anything else your agent can do.</p>
      <div class="code" title="click to copy">${code}</div>
      <p class="hint">In your terminal, at the <b>Paste a connect code</b> prompt.</p>
      <div class="status"><span class="spin"></span>waiting for you to approve…</div>
    </div>
    <div class="foot"><span class="brand">AgentPort</span><button data-cancel>Cancel</button></div>
  </div>`;
  root.append(style, back);

  const codeEl = back.querySelector('.code') as HTMLElement;
  codeEl.addEventListener('click', () => {
    void navigator.clipboard?.writeText(code).then(() => {
      const original = codeEl.textContent;
      codeEl.textContent = 'copied';
      setTimeout(() => (codeEl.textContent = original), 700);
    });
  });

  const statusEl = back.querySelector('.status') as HTMLElement;
  let onCancel: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onCancel = reject;
  });
  (back.querySelector('[data-cancel]') as HTMLElement).addEventListener('click', () => {
    host.remove();
    onCancel(new Error('cancelled by user'));
  });

  return {
    status: (text, error) => {
      statusEl.textContent = text;
      statusEl.classList.toggle('err', Boolean(error));
    },
    close: () => host.remove(),
    cancelled,
  };
}

// ---------------------------------------------------------------------------

const provider: AgentProvider = {
  version: '0.0.1',

  // Never dials the relay: a page must not be able to learn anything about
  // the user before they have agreed to anything.
  async isAvailable() {
    return true;
  },

  async connect(request: AgentConnectRequest): Promise<AgentSession> {
    const wallet = new AgentWallet({
      relayUrl: RELAY,
      // Ephemeral and authority-free. Discarded when the tab goes away.
      userSecretKey: generateKeyPair().secretKey,
    });
    await wallet.connect();

    const { code, accepted } = await wallet.beginConnect({
      surface: { name: request.name, route: request.route, context: request.context },
      tools: request.tools,
      alwaysAsk: request.alwaysAsk,
      ttlMs: request.ttlMs,
      // The owner already gated every `requiresApproval` tool before the call
      // reached us — re-asking here would be asking the requester.
      decide: () => true,
    });

    const modal = openModal(code, request.name);
    try {
      const session = await Promise.race([accepted, modal.cancelled]);
      modal.status('connected');
      setTimeout(() => modal.close(), 400);
      return session;
    } catch (err) {
      modal.status((err as Error).message, true);
      setTimeout(() => modal.close(), 2200);
      wallet.close();
      throw err;
    }
  },
};

/**
 * Provider discovery. An installed wallet wins — it can show the picker and
 * the consent screen in browser chrome, which is strictly better than carrying
 * a code by hand. The drop-in is what makes the site work for everyone else.
 */
export function getProvider(): AgentProvider {
  return (navigator as unknown as { agent?: AgentProvider }).agent ?? provider;
}

const AgentPort = {
  provider,
  getProvider,
  connect: (request: AgentConnectRequest) => getProvider().connect(request),
};

(globalThis as unknown as { AgentPort: typeof AgentPort }).AgentPort = AgentPort;

export default AgentPort;
export type { AgentConnectRequest, AgentSession };
