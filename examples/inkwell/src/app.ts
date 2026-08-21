/**
 * The Inkwell demo.
 *
 * Two things are happening in this one file, and they are deliberately kept
 * apart because in production they live in different places:
 *
 *   [WALLET]  — key custody, agent picker, consent, approvals.
 *               Ships as a browser extension. The page must not be able to
 *               reach inside it.
 *   [SITE]    — Inkwell itself. Declares tools, calls navigator.agent.connect,
 *               renders the conversation. Never sees a key or a model.
 */

import {
  AgentWallet,
  createWalletProvider,
  installProvider,
  ProviderRejected,
  type AgentSessionHandle,
  type AgentConnectRequest,
  type ApprovalPrompt,
  type SiteTool,
} from '@agentport/client';
import { generateKeyPair, isGated, type AgentSummary } from '@agentport/protocol';

const RELAY_URL = (globalThis as { AGENTPORT_RELAY?: string }).AGENTPORT_RELAY ?? 'ws://127.0.0.1:8787';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// [WALLET] key custody — dev only. A real wallet keeps this in extension
// storage behind a passkey, or delegates signing to a NIP-46 bunker.
// ---------------------------------------------------------------------------

function devUserKey(): string {
  const stored = localStorage.getItem('agentport.dev.userkey');
  if (stored) return stored;
  const keys = generateKeyPair();
  localStorage.setItem('agentport.dev.userkey', keys.secretKey);
  return keys.secretKey;
}

// ---------------------------------------------------------------------------
// [WALLET] dialogs
// ---------------------------------------------------------------------------

function openDialog<T>(dialog: HTMLDialogElement, onConfirm: () => T, cancelValue: T): Promise<T> {
  return new Promise((resolve) => {
    const close = (value: T) => {
      dialog.close();
      cleanup();
      resolve(value);
    };
    const confirmButton = dialog.querySelector<HTMLButtonElement>('.dlg-foot button:last-child')!;
    const cancelButtons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-close]')];
    const onOk = () => close(onConfirm());
    const onCancel = () => close(cancelValue);
    const cleanup = () => {
      confirmButton.removeEventListener('click', onOk);
      cancelButtons.forEach((b) => b.removeEventListener('click', onCancel));
      dialog.removeEventListener('cancel', onCancel);
    };
    confirmButton.addEventListener('click', onOk);
    cancelButtons.forEach((b) => b.addEventListener('click', onCancel));
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
  });
}

async function chooseAgent(agents: AgentSummary[]): Promise<AgentSummary | null> {
  const dialog = $<HTMLDialogElement>('picker');
  const list = $('picker-list');
  const ok = $<HTMLButtonElement>('picker-ok');
  let selected: AgentSummary | null = null;

  list.innerHTML = '';
  ok.disabled = true;

  for (const agent of agents) {
    const row = document.createElement('button');
    row.className = 'agent-row';
    row.type = 'button';
    row.disabled = !agent.online;
    row.innerHTML = `<span class="dot ${agent.online ? 'on' : ''}"></span><span>${agent.name}
      <small>${agent.runtime} · ${agent.location ?? 'unknown'} · ${agent.online ? 'Online' : 'Offline'}</small></span>`;
    row.addEventListener('click', () => {
      selected = agent;
      ok.disabled = false;
      for (const other of list.querySelectorAll('.agent-row')) other.setAttribute('aria-selected', 'false');
      row.setAttribute('aria-selected', 'true');
    });
    list.append(row);
  }

  return openDialog<AgentSummary | null>(dialog, () => selected, null);
}

async function confirmGrant(agent: AgentSummary, request: AgentConnectRequest): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('consent');
  $('consent-sub').textContent = `${request.name} → ${agent.name}`;

  const allowed = $('consent-caps');
  const gated = $('consent-ask');
  allowed.innerHTML = '';
  gated.innerHTML = '';

  for (const tool of request.tools) {
    const item = document.createElement('li');
    item.textContent = tool.description;
    if (isGated(tool, request)) {
      item.className = 'ask';
      gated.append(item);
    } else {
      allowed.append(item);
    }
  }
  if (!gated.childElementCount) gated.innerHTML = '<li style="color:var(--muted)">—</li>';

  return openDialog(dialog, () => true, false);
}

async function decide(prompt: ApprovalPrompt): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('approve');
  $('approve-summary').textContent = prompt.summary;
  $('approve-call').textContent = prompt.call
    ? `${prompt.call.name}(${JSON.stringify(prompt.call.arguments).slice(0, 160)})`
    : '';
  return openDialog(dialog, () => true, false);
}

// ---------------------------------------------------------------------------
// [SITE] Inkwell's own state and tools
// ---------------------------------------------------------------------------

const editor = $<HTMLTextAreaElement>('editor');

const tools: SiteTool[] = [
  {
    name: 'inkwell.document.read',
    description: 'Read the current document',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ documentId: 'doc_123', text: editor.value }),
  },
  {
    name: 'inkwell.document.getSelection',
    description: 'Read the selected text',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      text: editor.value.slice(editor.selectionStart, editor.selectionEnd),
      start: editor.selectionStart,
      end: editor.selectionEnd,
    }),
  },
  {
    name: 'inkwell.document.replaceSelection',
    description: 'Replace the selected text, or the whole document if nothing is selected',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    requiresApproval: true,
    handler: (args) => {
      const text = String(args.text ?? '');
      const { selectionStart: start, selectionEnd: end } = editor;
      editor.value = start === end ? text : editor.value.slice(0, start) + text + editor.value.slice(end);
      return { ok: true, length: editor.value.length };
    },
  },
  {
    name: 'inkwell.document.append',
    description: 'Append a paragraph to the end of the document',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: (args) => {
      editor.value = `${editor.value.trimEnd()}\n\n${String(args.text ?? '')}`;
      return { ok: true };
    },
  },
];

// ---------------------------------------------------------------------------
// [SITE] conversation panel
// ---------------------------------------------------------------------------

const log = $('log');

function line(kind: string, text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  log.append(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

let session: AgentSessionHandle | null = null;

function attach(next: AgentSessionHandle): void {
  session = next;
  $('empty').style.display = 'none';
  log.style.display = 'flex';
  $('composer').classList.add('live');
  const status = $('status');
  status.textContent = `${next.info.agentName} · ${next.info.runtime}`;
  status.className = 'online';

  line('meta', `connected · ${next.grant.tools.length} tools lent · grant expires ${new Date(next.grant.expiresAt).toLocaleTimeString()}`);

  let current: HTMLDivElement | null = null;
  next.on('delta', (event) => {
    if (!current) current = line('agent', '');
    current.textContent += event.text;
    log.scrollTop = log.scrollHeight;
  });
  next.on('thought', (event) => line('meta', event.text));
  next.on('tool', (event) => line(`tool ${event.ok ? 'ok' : 'err'}`, `${event.name}${event.ok ? '' : ` — ${event.error}`}`));
  next.on('done', () => {
    current = null;
  });
  next.on('closed', (event) => {
    line('meta', `session closed (${event.reason})`);
    status.textContent = 'disconnected';
    status.className = '';
    $('composer').classList.remove('live');
    session = null;
  });
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('input');
  const text = input.value.trim();
  if (!text || !session) return;
  input.value = '';
  line('user', text);
  session.prompt(text).catch((err: Error) => line('meta', `error: ${err.message}`));
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const wallet = new AgentWallet({ relayUrl: RELAY_URL, userSecretKey: devUserKey() });

const provider = createWalletProvider(wallet, { chooseAgent, confirmGrant, decide });
installProvider(provider);

$('connect').addEventListener('click', async () => {
  // [SITE] This is the entire integration a website has to write.
  try {
    const request: AgentConnectRequest = {
      name: 'Inkwell',
      route: '/documents/doc_123',
      context: { documentId: 'doc_123', title: 'Draft' },
      tools,
      alwaysAsk: ['inkwell.document.replaceSelection'],
    };
    attach(await navigator.agent.connect(request));
  } catch (err) {
    if (err instanceof ProviderRejected && err.reason === 'no_agents') {
      $('pair-status').textContent = 'No agents paired yet — pair one first.';
      $<HTMLDialogElement>('pairing').showModal();
      return;
    }
    line('meta', `connect failed: ${(err as Error).message}`);
  }
});

$('pair').addEventListener('click', () => $<HTMLDialogElement>('pairing').showModal());

$('pair-ok').addEventListener('click', async () => {
  const code = $<HTMLInputElement>('pair-code').value.trim().toUpperCase();
  const status = $('pair-status');
  if (!code) return;
  status.textContent = 'looking up…';
  try {
    const offer = await wallet.claimPairing(code);
    status.textContent = `Found ${offer.agent.name} (${offer.agent.runtime}). Signing ownership cert…`;
    const cert = await wallet.approvePairing(offer);
    status.textContent = `Paired ${cert.name}. You can close this and hit Connect agent.`;
  } catch (err) {
    status.textContent = `failed: ${(err as Error).message}`;
  }
});

await wallet.connect();
$('status').textContent = 'wallet ready';

// The daemon prints a link with #code=… — pick it up automatically.
const hashCode = /code=([A-Z2-9-]+)/i.exec(location.hash)?.[1];
if (hashCode) {
  $<HTMLInputElement>('pair-code').value = hashCode.toUpperCase();
  $<HTMLDialogElement>('pairing').showModal();
}

declare global {
  interface Navigator {
    agent: import('@agentport/client').AgentProvider;
  }
}
