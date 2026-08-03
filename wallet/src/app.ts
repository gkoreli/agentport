declare const __AGENTPORT_VERSION__: string | undefined;

import { component, computed, each, html, signal, when } from '@nisli/core';
import { AgentWallet, type PairOffer } from '@agentport/client';
import { signDelegation, type AgentCert } from '@agentport/protocol';
import { WALLET_CHANNEL, startWalletHandshake, type BoundWalletRequest } from './handshake.js';
import { ensureIdentity, loadCerts, saveCert } from './storage.js';

const VERSION = typeof __AGENTPORT_VERSION__ === 'string' ? __AGENTPORT_VERSION__ : 'dev';
const DELEGATION_TTL_MS = 8 * 60 * 60 * 1000;
const PRODUCTION_RELAY = 'wss://agentport.gogakoreli.workers.dev/relay';

type View = 'loading' | 'pair' | 'pick' | 'consent' | 'done';

interface AgentRow {
  cert: AgentCert;
  online: boolean;
}

function relayUrl(): string {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'ws://127.0.0.1:8787';
  return PRODUCTION_RELAY;
}

const WalletApp = component('agentport-wallet-app', () => {
  const view = signal<View>('loading');
  const request = signal<BoundWalletRequest | null>(null);
  const agents = signal<AgentRow[]>([]);
  const selected = signal<AgentRow | null>(null);
  const offer = signal<PairOffer | null>(null);
  const pairCode = signal(new URLSearchParams(location.hash.slice(1)).get('code') ?? '');
  const status = signal('Opening your wallet…');
  const busy = signal(false);

  const identity = ensureIdentity();
  let certs = loadCerts(identity.publicKey);
  const wallet = new AgentWallet({
    relayUrl: relayUrl(),
    userSecretKey: identity.secretKey,
    log: (message) => console.info(`[agentport-wallet] ${message}`),
  });
  let walletReady = false;

  const refreshView = () => {
    if (!walletReady || !request.value) {
      view.value = 'loading';
      return;
    }
    view.value = certs.length === 0 ? 'pair' : 'pick';
  };

  const refreshAgents = async () => {
    const live = new Map((await wallet.listAgents()).map((agent) => [agent.agent, agent]));
    agents.value = certs.map((cert) => ({ cert, online: live.has(cert.agent) }));
  };

  wallet.on('presence', ({ agent, online }) => {
    agents.value = agents.value.map((row) => (row.cert.agent === agent ? { ...row, online } : row));
  });

  startWalletHandshake((next) => {
    request.value = next;
    status.value = `Request from ${next.origin}`;
    refreshView();
  });

  void wallet
    .connect()
    .then(async () => {
      walletReady = true;
      await refreshAgents();
      refreshView();
    })
    .catch((err: unknown) => {
      console.error('[agentport-wallet] could not connect to the relay', err);
      status.value = `Could not reach the relay: ${err instanceof Error ? err.message : String(err)}`;
    });

  const onPairInput = (event: Event) => {
    pairCode.value = (event.currentTarget as HTMLInputElement).value.trim().toUpperCase();
    offer.value = null;
  };

  const lookupPairing = async () => {
    if (!pairCode.value || busy.value) return;
    busy.value = true;
    status.value = 'Looking up that agent…';
    try {
      offer.value = await wallet.claimPairing(pairCode.value);
      status.value = 'Confirm this is your agent.';
    } catch (err) {
      console.error('[agentport-wallet] pairing lookup failed', err);
      status.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  };

  const approvePairing = async () => {
    const current = offer.value;
    if (!current || busy.value) return;
    busy.value = true;
    status.value = 'Signing ownership certificate…';
    try {
      const cert = await wallet.approvePairing(current);
      certs = saveCert(cert);
      await refreshAgents();
      offer.value = null;
      pairCode.value = '';
      view.value = 'pick';
      status.value = 'Agent paired.';
    } catch (err) {
      console.error('[agentport-wallet] pairing approval failed', err);
      status.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  };

  const choose = (row: AgentRow) => {
    if (!row.online) return;
    selected.value = row;
    view.value = 'consent';
  };

  const approveConnect = () => {
    const bound = request.value;
    const agent = selected.value;
    if (!bound || !agent || busy.value) return;
    busy.value = true;
    try {
      const delegation = signDelegation(identity.secretKey, {
        delegate: bound.request.delegate,
        agent: agent.cert.agent,
        // This is the browser-authenticated MessageEvent.origin captured by
        // the source-bound handshake, never a page-provided payload field.
        origin: bound.origin,
        expiresAt: Date.now() + DELEGATION_TTL_MS,
      });
      bound.reply({
        e: WALLET_CHANNEL,
        t: 'connect.result',
        id: bound.request.id,
        result: { agent: agent.cert.agent, displayName: 'Personal agent', delegation },
      });
      view.value = 'done';
      status.value = 'Approved. Returning to the site…';
      setTimeout(() => window.close(), 250);
    } catch (err) {
      console.error('[agentport-wallet] delegation signing failed', err);
      status.value = err instanceof Error ? err.message : String(err);
      busy.value = false;
    }
  };

  const boundOrigin = computed(() => request.value?.origin ?? 'the requesting site');
  const selectedName = computed(() => selected.value?.cert.name ?? 'Personal agent');
  const offerVisible = computed(() => offer.value !== null);
  const offerName = computed(() => offer.value?.agent.name ?? '');
  const offerMeta = computed(() => {
    const agent = offer.value?.agent;
    return agent ? `${agent.runtime}${agent.location ? ` · ${agent.location}` : ''}` : '';
  });
  const requestedTools = computed(() => request.value?.request.tools ?? []);

  const agentRows = each(
    agents,
    (row) => row.cert.agent,
    (row) => {
      const name = computed(() => row.value.cert.name);
      const meta = computed(() => `${row.value.cert.runtime}${row.value.cert.location ? ` · ${row.value.cert.location}` : ''}`);
      const online = computed(() => row.value.online);
      const label = computed(() => (row.value.online ? 'Select' : 'Offline'));
      return html`<li class="agent-row">
        <span class="presence" class:online=${online} aria-hidden="true"></span>
        <span class="agent-copy"><strong>${name}</strong><small>${meta}</small></span>
        <button disabled=${computed(() => !row.value.online)} @click=${() => choose(row.value)}>${label}</button>
      </li>`;
    },
  );

  const toolRows = each(
    requestedTools,
    (tool) => tool.name,
    (tool) => {
      const name = computed(() => tool.value.name);
      const description = computed(() => tool.value.description);
      const gated = computed(
        () => tool.value.requiresApproval === true || (request.value?.request.alwaysAsk.includes(tool.value.name) ?? false),
      );
      return html`<li class="tool-row">
        <span><strong>${name}</strong><small>${description}</small></span>
        ${when(gated, () => html`<em>asks every time</em>`)}
      </li>`;
    },
  );

  const page = computed(() => {
    switch (view.value) {
      case 'loading':
        return html`<section class="center"><div class="spinner"></div><h1>AgentPort Wallet</h1><p>${status}</p></section>`;
      case 'pair':
        return html`<section>
          <p class="eyebrow">Pair once</p>
          <h1>Add your agent</h1>
          <p>Paste the pairing code shown by your daemon. The certificate stays in this wallet origin.</p>
          <label>Pairing code<input value=${pairCode} @input=${onPairInput} placeholder="ABCD-2345" autocomplete="off" /></label>
          <button class="primary wide" disabled=${busy} @click=${lookupPairing}>Look up agent</button>
          ${when(
            offerVisible,
            () => html`<div class="offer"><strong>${offerName}</strong><small>${offerMeta}</small>
              <button class="primary wide" disabled=${busy} @click=${approvePairing}>Approve pairing</button></div>`,
          )}
          <p class="status">${status}</p>
        </section>`;
      case 'pick':
        return html`<section>
          <p class="eyebrow">${boundOrigin}</p>
          <h1>Choose an agent</h1>
          <p>Real names stay in this popup. The site sees only “Personal agent.”</p>
          <ul class="agent-list">${agentRows}</ul>
          <div class="actions"><button class="ghost" @click=${() => (view.value = 'pair')}>Pair another</button><button class="ghost" @click=${() => window.close()}>Cancel</button></div>
          <p class="status">${status}</p>
        </section>`;
      case 'consent':
        return html`<section>
          <p class="eyebrow">Verified requester</p>
          <h1>${boundOrigin}</h1>
          <p>Allow <strong>${selectedName}</strong> to use these site tools for this attachment?</p>
          <ul class="tool-list">${toolRows}</ul>
          <p class="delegation-note">The page receives an 8-hour delegation to its fresh key. Gated tools still ask in the site panel.</p>
          <div class="actions"><button class="ghost" @click=${() => (view.value = 'pick')}>Back</button><button class="primary" disabled=${busy} @click=${approveConnect}>Allow</button></div>
          <p class="status">${status}</p>
        </section>`;
      case 'done':
        return html`<section class="center"><div class="check">✓</div><h1>Connected</h1><p>${status}</p></section>`;
    }
  });

  return html`<main><header><span class="mark">A</span><span>AgentPort Wallet</span><small>v${VERSION}</small></header>${page}</main>`;
});

const mount = document.querySelector('#wallet');
if (!mount) throw new Error('wallet mount is missing');
html`${WalletApp({})}`.mount(mount as HTMLElement);
