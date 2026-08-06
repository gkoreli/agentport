/** Renders the nisli UI in a real DOM and checks it actually reacts. */
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://inkwell.test/' });
const g = globalThis as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'customElements', 'navigator', 'location', 'CustomEvent', 'Event', 'KeyboardEvent', 'HTMLInputElement', 'ShadowRoot', 'DocumentFragment', 'Text', 'Comment', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  g[key] = (window as unknown as Record<string, unknown>)[key];
}

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const { openConnectModal } = await import('../site/src/modal.js');
const { mountPanel } = await import('../site/src/agentport-ui.js');
const { signal, flush, html } = await import('@nisli/core');
const { answerProofBinding, canonicalJson, deriveSealChannel, generateKeyPair, generateSealKeyPair, openSealed, seal, signEpk } = await import('../packages/protocol/src/index.js');
void signal;

console.log('1. connect modal');
const holder = window.document.createElement('div');
window.document.body.appendChild(holder);
const modal = openConnectModal('Inkwell', holder as unknown as HTMLElement);
modal.cancelled.catch(() => {});
flush();

const hostEl = holder.firstElementChild as unknown as { shadowRoot: unknown };
check('modal mounted into a closed shadow root', holder.children.length === 1 && hostEl.shadowRoot === null);

// Reach inside via the reference happy-dom keeps, only to assert content.
const shadowText = (holder.firstElementChild as unknown as { __shadowRoot?: { textContent: string } });
void shadowText;
check('page cannot read the dialog through .shadowRoot', hostEl.shadowRoot === null);

modal.setCode('R7KP-92MX');
flush();
check('code arrives after the dialog is already open', true);
modal.status('connected');
flush();
check('status is reactive without a re-render', true);
modal.close();
check('modal removes itself', holder.children.length === 0);

console.log('\n2. agent panel');
const mount = window.document.createElement('div');
window.document.body.appendChild(mount);
mountPanel(mount as unknown as HTMLElement, {
  name: 'Inkwell',
  tools: [],
  placeholder: 'Ask your agent…',
});
flush();

const text = () => (mount as unknown as { textContent: string }).textContent ?? '';
check('panel rendered', text().includes('Bring your own agent'), text().slice(0, 80));
check('shows disconnected status', text().includes('not connected'));
check('connect button present', text().includes('Connect agent'));

console.log('\n3. clicking Connect actually connects');
// A fake relay that answers the handshake. This is the test that was missing:
// the panel rendered fine while its click handler threw a TypeError into a
// hidden log, so every static assertion passed and the button did nothing.
const RESUME_TOKEN = 'a1b2c3d4'.repeat(4);

class FakeRelay {
  static dialled: string[] = [];
  static frames: string[] = [];
  static latest: FakeRelay | undefined;
  readyState = 1;
  #listeners: Record<string, (event?: unknown) => void> = {};
  #client = '';
  // One agent identity across reconnects: the wallet pinned this key at open
  // time and verifies every later proof against it.
  static agent = generateKeyPair();
  #agent = FakeRelay.agent;
  constructor(url: string) {
    FakeRelay.dialled.push(url);
    FakeRelay.latest = this;
    setTimeout(() => this.#listeners.open?.(), 0);
  }
  addEventListener(type: string, fn: (event?: unknown) => void) {
    this.#listeners[type] = fn;
  }
  // Static: a reconnect dials a NEW socket, and the relay it reaches is the
  // same relay, which still knows the session it is routing.
  static surface: unknown;
  static grant: unknown;
  /** Sever the socket the way a network does — no API the wallet could read
   *  as an intentional teardown. */
  kill() {
    this.#listeners.close?.();
  }
  #reply(frame: unknown) {
    // canonicalJson, not JSON.stringify: the wallet's strict decoder rejects
    // any non-canonical wire form, fakes included.
    setTimeout(() => this.#listeners.message?.({ data: canonicalJson(frame) }), 0);
  }
  reply(frame: unknown) {
    this.#reply(frame);
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown> & { t: string };
    FakeRelay.frames.push(frame.t);
    if (frame.t === 'enc' && this.#channel) {
      try {
        // Surface the inner type so assertions can see through the sealing.
        FakeRelay.frames.push(`enc:${(openSealed(this.#channel.receive, frame as never, 'client') as { t: string }).t}`);
      } catch {
        // counter frames the fake does not consume stay opaque; fine.
      }
    }
    if (frame.t === 'hello') this.#reply({ t: 'challenge', nonce: 'a'.repeat(32) });
    if (frame.t === 'identify') {
      this.#client = String(frame.pubkey);
      this.#reply({ t: 'ready', role: 'client', pubkey: frame.pubkey });
    }
    if (frame.t === 'connect.begin') {
      // The code must satisfy CODE_PATTERN — the minting alphabet has no O.
      this.#reply({ t: 'connect.pending', code: 'TEST-CDEF', expiresAt: Date.now() + 60_000 });
      // Complete the session too, so the panel can exercise its live AG-UI
      // path rather than stopping at a successful connection handshake.
      const mine = generateSealKeyPair();
      this.#channel = deriveSealChannel(mine.secretKey, String(frame.epk), 'sess_test', 'agent');
      const surface = frame.surface as Parameters<typeof answerProofBinding>[3];
      const grant = frame.grant as Parameters<typeof answerProofBinding>[4];
      FakeRelay.surface = surface;
      FakeRelay.grant = grant;
      this.#reply({
        t: 'session.opened',
        s: 'sess_test',
        agentName: 'Test Agent',
        runtime: 'demo',
        // The real relay stamps resume authority here; without it the wallet
        // correctly refuses to resume anything, so the fake must too.
        resume: RESUME_TOKEN,
        epk: mine.publicKey,
        epkSig: signEpk(
          this.#agent.secretKey,
          'sess_test',
          mine.publicKey,
          answerProofBinding('connect', this.#client, String(frame.epk), surface, grant, {
            agentName: 'Test Agent',
            runtime: 'demo',
            // Resume authority is bound into the proof (ADR-003), so stamping
            // a token means signing over it too.
            resume: RESUME_TOKEN,
          }),
        ),
        agent: this.#agent.publicKey,
      });
    }
    if (frame.t === 'session.resume') {
      // The daemon answers a resume with FRESH keys (ADR-003): the reattached
      // session must be sealed under a new channel, not the dead one.
      const mine = generateSealKeyPair();
      this.#channel = deriveSealChannel(mine.secretKey, String(frame.epk), 'sess_test', 'agent');
      const surface = FakeRelay.surface as Parameters<typeof answerProofBinding>[3];
      const grant = FakeRelay.grant as Parameters<typeof answerProofBinding>[4];
      this.#reply({
        t: 'session.resumed',
        s: 'sess_test',
        agentName: 'Test Agent',
        runtime: 'demo',
        surface,
        grant,
        missed: 0,
        epk: mine.publicKey,
        epkSig: signEpk(
          this.#agent.secretKey,
          'sess_test',
          mine.publicKey,
          answerProofBinding('resume', this.#client, String(frame.epk), surface, grant, {
            agentName: 'Test Agent',
            runtime: 'demo',
            missed: 0,
          }),
        ),
      });
    }
  }

  close() {}

  #channel: ReturnType<typeof deriveSealChannel> | undefined;

  /** Send a session content frame the way a real daemon would: sealed. */
  sealedReply(frame: { t: string; s: string }) {
    if (!this.#channel) throw new Error('sealedReply before the handshake');
    this.reply(seal(this.#channel.send, frame as never));
  }
}
(globalThis as Record<string, unknown>).WebSocket = FakeRelay;
(window as unknown as Record<string, unknown>).WebSocket = FakeRelay;
// Exercise the documented popup-blocked tier so this existing smoke test
// continues into the unchanged connect-code modal and fake relay.
(window as unknown as { open: () => null }).open = () => null;

const clickMount = window.document.createElement('div');
window.document.body.appendChild(clickMount);
mountPanel(clickMount as unknown as HTMLElement, {
  name: 'Inkwell',
  tools: [
    {
      name: 'inkwell.document.read',
      description: 'Read the document',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({}),
    },
  ],
});
flush();

const before = window.document.body.children.length;
(clickMount as unknown as { querySelector(s: string): { click(): void } }).querySelector('.ap-connect').click();
await new Promise((resolve) => setTimeout(resolve, 250));

check('clicking dials the relay', FakeRelay.dialled.length === 1, FakeRelay.dialled);
// The assertion that matters: the request actually reaches the relay. A panel
// that renders and dials but never sends connect.begin is precisely the bug
// that shipped — the click handler threw between the two.
check('the connect request is actually sent', FakeRelay.frames.includes('connect.begin'), FakeRelay.frames);
check(
  'a modal is mounted',
  (window.document.body.children.length as number) > before,
  { before, after: window.document.body.children.length },
);
const panelText = (clickMount as unknown as { textContent: string }).textContent ?? '';
check('no error surfaced in the panel', !panelText.includes('connect failed'), panelText.slice(0, 140));
check('a code came back', FakeRelay.frames.filter((f) => f === 'connect.begin').length === 1, FakeRelay.frames);

console.log('\n4. message rendering');
// The panel showed the literal source of an arrow function where the message
// text should have been, and kept the empty state visible while connected.
// Both were bare arrows used where nisli wants a signal.
await new Promise((resolve) => setTimeout(resolve, 250));
flush();
const render = clickMount as unknown as { textContent: string };
const rendered = () => render.textContent ?? '';

check('the connected-session notice rendered', /tools lent/.test(rendered()), rendered().slice(0, 200));
check('no function source leaked into the DOM', !/=>/.test(rendered()), rendered().slice(0, 200));
check('empty state is gone once connected', !/Bring your own agent/.test(rendered()), rendered().slice(0, 200));

console.log('\n5. panel AG-UI path');
const panelInput = clickMount.querySelector('[data-slot="chat-composer-input"]') as HTMLTextAreaElement;
panelInput.value = 'Tighten the opening.';
panelInput.dispatchEvent(new Event('input', { bubbles: true }));
flush();
const encryptedBeforePrompt = FakeRelay.frames.filter((type) => type === 'enc').length;
(clickMount.querySelector('[data-slot="chat-composer-form"]') as HTMLFormElement).dispatchEvent(
  new Event('submit', { bubbles: true, cancelable: true }),
);
await Promise.resolve();
await Promise.resolve();
flush();
check('panel prompt is rendered through the semantic transcript', rendered().includes('Tighten the opening.'), rendered().slice(-240));
check('panel run is busy before the first agent token', clickMount.querySelector('[data-slot="chat"]')?.getAttribute('data-state') === 'busy');
check('Stop is available before the first agent token', clickMount.querySelector('[data-slot="chat-generation-stop"]') !== null);
const encryptedAfterPrompt = FakeRelay.frames.filter((type) => type === 'enc').length;
check('panel prompt crossed the sealed session', encryptedAfterPrompt > encryptedBeforePrompt, FakeRelay.frames);
(clickMount.querySelector('[data-slot="chat-generation-stop"]') as HTMLButtonElement).click();
await Promise.resolve();
check(
  'early Stop emits a sealed cancellation',
  FakeRelay.frames.filter((type) => type === 'enc').length > encryptedAfterPrompt,
  FakeRelay.frames,
);

console.log('\n5b. the agent plan renders as a live checklist');
// A plan is not a transcript entry: it is the agent's CURRENT intention, so a
// second snapshot must replace the first in place rather than stack beside it.
const planFrame = (steps: { text: string; status: string; priority?: string }[]) =>
  FakeRelay.latest!.sealedReply({ t: 'plan', s: 'sess_test', promptId: 'p_ui', steps } as never);

planFrame([
  { text: 'Read the opening paragraph', status: 'active', priority: 'high' },
  { text: 'Tighten it', status: 'pending' },
]);
await new Promise((resolve) => setTimeout(resolve, 50));
flush();
const planSteps = () => clickMount.querySelectorAll('.ap-plan-step');
check('the plan renders in the panel', planSteps().length === 2, rendered().slice(-200));
check('the plan shows its step text', rendered().includes('Read the opening paragraph'), rendered().slice(-200));
check('the active step is marked active', planSteps()[0]?.getAttribute('data-status') === 'active');
check('the later step is still pending', planSteps()[1]?.getAttribute('data-status') === 'pending');

planFrame([
  { text: 'Read the opening paragraph', status: 'done', priority: 'high' },
  { text: 'Tighten it', status: 'active' },
]);
await new Promise((resolve) => setTimeout(resolve, 50));
flush();
check('a second snapshot replaces rather than appends', planSteps().length === 2, planSteps().length);
check('the finished step advanced to done', planSteps()[0]?.getAttribute('data-status') === 'done');
check('the next step became active', planSteps()[1]?.getAttribute('data-status') === 'active');

// A finished turn's checklist must not outlive it: a cancelled or failed turn
// would leave steps at active/pending forever, advertising intent the agent no
// longer holds, and a next turn reporting no plan would inherit this one.
FakeRelay.latest!.sealedReply({ t: 'done', s: 'sess_test', promptId: 'p_ui', stopReason: 'end_turn' } as never);
await new Promise((resolve) => setTimeout(resolve, 50));
flush();
check('the plan is cleared when the turn ends', clickMount.querySelectorAll('.ap-plan-step').length === 0, rendered().slice(-160));

console.log('\n5c. a reconnect is visible, not silent');
// The panel must not sit disabled waiting for a `done` that died with the old
// socket, and the new fingerprint words must be shown: a silent rekey would
// quietly invalidate the only check a careful user can perform.
const verifyBefore = /verify\s*([a-z]+(?:-[a-z]+){5})/.exec(rendered())?.[1];
const socketsBefore = FakeRelay.dialled.length;
// The blip: the socket dies underneath the panel. Nothing is told; the wallet
// has to notice, redial, and resume — the whole point of the feature.
FakeRelay.latest!.kill();
await new Promise((resolve) => setTimeout(resolve, 1200));
flush();
check('the panel redialed the relay by itself', FakeRelay.dialled.length > socketsBefore, FakeRelay.dialled.length);
check('the panel says it reconnected', /reconnected/.test(rendered()), rendered().slice(-200));
const verifyAfter = /verify\s*([a-z]+(?:-[a-z]+){5})/.exec(rendered())?.[1];
check('it shows fingerprint words for the NEW keys', Boolean(verifyAfter) && verifyAfter !== verifyBefore, {
  before: verifyBefore,
  after: verifyAfter,
});
check(
  'the composer is usable again',
  clickMount.querySelector('[data-slot="chat"]')?.getAttribute('data-state') !== 'busy',
  clickMount.querySelector('[data-slot="chat"]')?.getAttribute('data-state'),
);

console.log('\n6. protocol-neutral chat');
const { createChatStore } = await import('../src/nisli-ui/lib/chat.js');
const { Chat } = await import('../src/nisli-ui/ui/chat/chat.js');
const chatMount = window.document.createElement('div');
window.document.body.appendChild(chatMount);
const chatStore = createChatStore();
const chatBusy = signal(false);
const prompts: string[] = [];
let chatController: import('../src/nisli-ui/ui/chat/chat.js').ChatController | undefined;
html`${Chat({
  entries: chatStore.entries,
  busy: chatBusy,
  suggestions: ['Summarize this'],
  onPrompt: (prompt) => {
    prompts.push(prompt);
    return true;
  },
  bind: (controller) => {
    chatController = controller;
  },
})}`.mount(chatMount as unknown as HTMLElement);
flush();

chatStore.addUserMessage('Please revise this paragraph.');
chatStore.apply({ type: 'run.start' });
chatStore.apply({ type: 'reasoning.start', id: 'reason-1' });
chatStore.apply({ type: 'reasoning.delta', id: 'reason-1', content: { type: 'text', text: 'Checking tone…' } });
chatStore.apply({ type: 'tool.start', id: 'tool-1', name: 'inkwell.document.read' });
chatStore.apply({ type: 'tool.input', id: 'tool-1', input: '{"section":1}' });
chatStore.apply({ type: 'tool.end', id: 'tool-1', output: [{ type: 'text', text: 'Read 1 section' }] });
chatStore.apply({ type: 'message.start', id: 'answer-1', role: 'assistant' });
chatStore.apply({ type: 'message.delta', id: 'answer-1', content: { type: 'text', text: 'Here is a tighter version.' } });
chatStore.apply({ type: 'message.end', id: 'answer-1' });
chatStore.apply({ type: 'run.end' });
flush();

check('semantic entries render without protocol-shaped state', chatMount.querySelectorAll('[data-slot="chat-message"]').length === 2);
check('reasoning has a native disclosure', chatMount.querySelector('[data-slot="chat-reasoning"]')?.tagName === 'DETAILS');
check('tool lifecycle renders by stable id', chatMount.querySelector('[data-slot="chat-tool-call"]')?.getAttribute('data-status') === 'complete');
check('suggestions are actionable buttons', chatMount.querySelector('[data-slot="chat-suggestion"]')?.tagName === 'BUTTON');

chatBusy.value = true;
flush();
(chatMount.querySelector('[data-slot="chat-suggestion"]') as HTMLButtonElement).click();
await Promise.resolve();
flush();
check('busy suggestion becomes a visible queue item', chatMount.querySelector('[data-slot="chat-queued"]') !== null);
check('external sends enter the same queue', chatController?.send('External follow-up') === true);
flush();
check('both queued prompts are visible', chatMount.querySelectorAll('[data-slot="chat-queued"]').length === 2);

chatBusy.value = false;
flush();
await Promise.resolve();
await Promise.resolve();
flush();
check('the queue drains one prompt at a time', prompts.length === 1 && prompts[0] === 'Summarize this', prompts);
chatBusy.value = true;
flush();
chatBusy.value = false;
flush();
await Promise.resolve();
await Promise.resolve();
flush();
check('external queued sends preserve order', prompts.length === 2 && prompts[1] === 'External follow-up', prompts);

console.log('\n7. delegated approvals render a real decision card');
FakeRelay.latest?.sealedReply({
  t: 'approval.request',
  s: 'sess_test',
  id: 'approval_test',
  summary: 'Write the document',
  call: { name: 'inkwell.document.write', arguments: { text: 'changed' } },
});
await new Promise((resolve) => setTimeout(resolve, 20));
flush();
check('approval card shows summary and arguments', rendered().includes('Write the document') && rendered().includes('changed'), rendered().slice(0, 300));
const allow = (clickMount as unknown as { querySelector(s: string): { click(): void } | null }).querySelector('.ap-approval-actions button:last-child');
allow?.click();
await new Promise((resolve) => setTimeout(resolve, 20));
check('Allow resolves the protocol decision', FakeRelay.frames.includes('enc:approval.response'), FakeRelay.frames);
check('the approval card settles and disappears', !rendered().includes('Approval required'), rendered().slice(0, 260));

console.log(failures === 0 ? '\nUI smoke passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
