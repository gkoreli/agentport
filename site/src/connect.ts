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
import { openConnectModal } from './modal.js';

function relayUrl(): string {
  const configured = document.currentScript?.getAttribute('data-relay');
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
}

const RELAY = relayUrl();

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

    const modal = openConnectModal(code, request.name);
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
