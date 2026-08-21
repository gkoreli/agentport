/**
 * The popup's half of the worker: identity, relay, pairing, and the agent list.
 *
 * Everything here is extension-origin on both ends — our own popup talking to
 * our own worker — which is why it is a different surface from the content
 * script's, not a variant of it. No page ever reaches these verbs, and none of
 * them opens, drives or answers for a session. The one exception is `sessions`,
 * which READS the worker's live table so a user can see what currently holds
 * their agent; it is injected as an accessor rather than imported, because the
 * table belongs to the session registry and this module must not be a second
 * way to reach it.
 *
 * The wallet is injected for the sharper reason. `identity.create`,
 * `identity.import` and `relay.set` all invalidate the socket the worker
 * dialled — an `AgentWallet` is bound to the key it authenticated with and the
 * relay it authenticated against — so this module must be able to say "let go
 * of that one" without owning the connection or being able to hold a second.
 *
 * The user key is used for exactly one thing here that is not authentication:
 * signing an ownership cert at `pair.approve`. It is signed inside the worker,
 * from a key that never left it.
 */

import type { AgentWallet } from '@agentport/client';
import { createLogger, toErr, type Logger } from '@agentport/protocol';

import { isRecord, toAgentRow, type Origin, type PopupToWorker } from './bridge.js';
import { DEFAULT_RELAY_URL, ensureUserKey, importUserKey, loadCerts, relayUrl, saveCert, setRelayUrl, userPublicKey } from './storage.js';

/** One live attachment, as the popup renders it. */
export interface PopupSessionRow {
  ref: string;
  origin: string;
  from: Origin;
  agentName: string;
  tools: string[];
  expiresAt: number;
}

export interface PopupApiOptions {
  /** The worker's one authenticated relay socket. */
  wallet(): Promise<AgentWallet>;
  /**
   * Let go of the current wallet: the identity or the relay it was built with
   * has just changed underneath it, so the next caller must dial a fresh one.
   */
  forgetWallet(): void;
  /** The live session table. Owned by the worker's registry, read-only here. */
  sessions(): PopupSessionRow[];
  log?: Logger;
}

export class PopupApi {
  readonly #options: PopupApiOptions;
  readonly #log: Logger;
  /**
   * Pairing offers claimed but not yet approved, keyed by their code.
   *
   * Held across two messages because the popup asks the user to confirm the
   * agent between them, and the offer is what the confirmation is ABOUT — a
   * second `claimPairing` would be a different offer for the same code.
   */
  readonly #offers = new Map<
    string,
    { code: string; agent: { pubkey: string; name: string; runtime: string; location?: string } }
  >();

  constructor(options: PopupApiOptions) {
    this.#options = options;
    this.#log = options.log ?? createLogger('extension.popup-api');
  }

  handlePort(port: chrome.runtime.Port): void {
    port.onMessage.addListener((raw: unknown) => {
      if (!isRecord(raw) || typeof raw['rid'] !== 'string') return;
      const rid = raw['rid'];
      const reply = (message: unknown) => {
        try {
          port.postMessage(message);
        } catch {
          // The popup was closed; there is no remaining user-visible surface to update.
        }
      };
      void this.#onMessage(raw as unknown as PopupToWorker)
        .then((value) => reply({ t: 'ok', rid, value }))
        .catch((err: unknown) => {
          this.#log.error('popup request failed', { err, data: { messageType: raw['t'] } });
          reply({ t: 'err', rid, message: toErr(err).message });
        });
    });
  }

  async #onMessage(message: PopupToWorker): Promise<unknown> {
    switch (message.t) {
      case 'identity':
        return { pubkey: await userPublicKey(), relay: await relayUrl(), defaultRelay: DEFAULT_RELAY_URL };
      case 'identity.create': {
        await ensureUserKey();
        this.#options.forgetWallet();
        return { pubkey: await userPublicKey() };
      }
      case 'identity.import': {
        await importUserKey(String(message.secretKey ?? '').trim());
        this.#options.forgetWallet();
        return { pubkey: await userPublicKey() };
      }
      case 'relay.set': {
        const url = await setRelayUrl(String(message.url ?? '').trim());
        this.#options.forgetWallet();
        return { relay: url };
      }
      case 'agents': {
        // Durable list from our own cert store; liveness from the relay.
        const wallet = await this.#options.wallet();
        const [owned, live] = await Promise.all([loadCerts(), wallet.listAgents()]);
        const online = new Set(live.map((agent) => agent.agent));
        const rows = owned.map((cert) => ({ ...cert, online: online.has(cert.agent) }));
        for (const agent of live) {
          if (!rows.some((row) => row.agent === agent.agent)) rows.push(toAgentRow(agent));
        }
        return { agents: rows };
      }
      case 'pair.claim': {
        const wallet = await this.#options.wallet();
        const offer = await wallet.claimPairing(String(message.code ?? '').trim().toUpperCase());
        this.#offers.set(offer.code, offer);
        return offer;
      }
      case 'pair.approve': {
        const offer = this.#offers.get(String(message.code ?? ''));
        if (!offer) throw new Error('claim the pairing code first');
        const wallet = await this.#options.wallet();
        // The cert is signed here, inside the worker, from a key that never left
        // it. This is the one moment the user key is used for anything but auth.
        const cert = await wallet.approvePairing(offer, message.name ? { name: message.name } : {});
        this.#offers.delete(offer.code);
        // The wallet is the durable directory (ADR-016): the stateless relay
        // will only ever report live agents, so remember what we own here.
        await saveCert({ agent: cert.agent, name: cert.name, runtime: cert.runtime, location: cert.location });
        return { cert: { agent: cert.agent, name: cert.name, runtime: cert.runtime } };
      }
      case 'sessions':
        return { sessions: this.#options.sessions() };
      default:
        throw new Error('unknown request');
    }
  }
}
