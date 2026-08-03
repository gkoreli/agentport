import type { AgentSummary } from '@agentport/protocol';
import type { AgentWallet } from './wallet.js';
import type { AgentSessionHandle, ApprovalDecider, SiteTool } from './session.js';

/**
 * `navigator.agent` — the one primitive this project adds.
 *
 * NIP-07 gave sites `window.nostr`: "here is my identity, sign this". This is
 * the same shape for agents: "here are my tools, run them on my behalf". The
 * site never learns which runtime, which model, or who pays for inference.
 */
export interface AgentConnectRequest {
  /** Display name of the surface, e.g. "Inkwell". */
  name: string;
  /** Optional route/resource this session is scoped to. */
  route?: string;
  /** Context handed to the agent at session start. */
  context?: Record<string, unknown>;
  /** Tools the site lends the agent for the lifetime of the session. */
  tools: SiteTool[];
  /** Tool names that must be approved on every invocation. */
  alwaysAsk?: string[];
  /** How long the grant is valid. */
  ttlMs?: number;
}

export interface AgentProvider {
  readonly version: string;
  /** True when a wallet is reachable and the user has at least one agent. */
  isAvailable(): Promise<boolean>;
  /** Runs the picker + consent flow, then returns a live session. */
  connect(request: AgentConnectRequest): Promise<AgentSessionHandle>;
}

/** UI the wallet delegates to. In an extension these are browser-chrome dialogs. */
export interface WalletUi {
  chooseAgent(agents: AgentSummary[]): Promise<AgentSummary | null>;
  confirmGrant(agent: AgentSummary, request: AgentConnectRequest): Promise<boolean>;
  decide: ApprovalDecider;
}

export class ProviderRejected extends Error {
  constructor(readonly reason: 'no_agents' | 'cancelled' | 'denied') {
    super(`agent connection ${reason}`);
    this.name = 'ProviderRejected';
  }
}

export function createWalletProvider(wallet: AgentWallet, ui: WalletUi): AgentProvider {
  return {
    version: '0.0.1',

    async isAvailable() {
      const agents = await wallet.listAgents();
      return agents.length > 0;
    },

    async connect(request) {
      const agents = await wallet.listAgents();
      if (agents.length === 0) throw new ProviderRejected('no_agents');

      const chosen = await ui.chooseAgent(agents);
      if (!chosen) throw new ProviderRejected('cancelled');

      const consented = await ui.confirmGrant(chosen, request);
      if (!consented) throw new ProviderRejected('denied');

      return wallet.openSession({
        agent: chosen.agent,
        surface: { name: request.name, route: request.route, context: request.context },
        tools: request.tools,
        alwaysAsk: request.alwaysAsk,
        ttlMs: request.ttlMs,
        decide: ui.decide,
      });
    },
  };
}

/** Expose the provider to page scripts as `navigator.agent` (and `window.agent`). */
export function installProvider(provider: AgentProvider): void {
  const target = globalThis as unknown as { navigator?: object; agent?: AgentProvider };
  if (target.navigator) {
    Object.defineProperty(target.navigator, 'agent', {
      value: provider,
      configurable: true,
      enumerable: false,
    });
  }
  target.agent = provider;
  globalThis.dispatchEvent?.(new Event('agent#initialized'));
}
