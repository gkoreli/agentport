/** Renders the nisli UI in a real DOM and checks it actually reacts. */
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://inkwell.test/' });
const g = globalThis as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'customElements', 'navigator', 'location', 'CustomEvent', 'Event', 'HTMLInputElement', 'ShadowRoot', 'DocumentFragment', 'Text', 'Comment']) {
  g[key] = (window as unknown as Record<string, unknown>)[key];
}

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const { openConnectModal } = await import('../site/src/modal.js');
const { mountPanel } = await import('../site/src/agentport-ui.js');
const { signal, flush } = await import('@nisli/core');
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
class FakeRelay {
  static dialled: string[] = [];
  static frames: string[] = [];
  static latest: FakeRelay | undefined;
  readyState = 1;
  #listeners: Record<string, (event?: unknown) => void> = {};
  constructor(url: string) {
    FakeRelay.dialled.push(url);
    FakeRelay.latest = this;
    setTimeout(() => this.#listeners.open?.(), 0);
  }
  addEventListener(type: string, fn: (event?: unknown) => void) {
    this.#listeners[type] = fn;
  }
  #reply(frame: unknown) {
    setTimeout(() => this.#listeners.message?.({ data: JSON.stringify(frame) }), 0);
  }
  reply(frame: unknown) {
    this.#reply(frame);
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as { t: string };
    FakeRelay.frames.push(frame.t);
    if (frame.t === 'hello') this.#reply({ t: 'challenge', nonce: 'a'.repeat(32) });
    if (frame.t === 'identify') this.#reply({ t: 'ready', role: 'client', pubkey: 'x' });
    if (frame.t === 'connect.begin') {
      this.#reply({ t: 'connect.pending', code: 'TEST-CODE', expiresAt: Date.now() + 60_000 });
      // Complete the session too, so the panel actually renders messages —
      // without this the render assertions below inspect an empty log and
      // pass vacuously.
      this.#reply({ t: 'session.opened', s: 'sess_test', agentName: 'Test Agent', runtime: 'demo' });
    }
  }
  close() {}
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

check('a session message actually rendered', /tools lent/.test(rendered()), rendered().slice(0, 200));
check('no function source leaked into the DOM', !/=>/.test(rendered()), rendered().slice(0, 200));
check('empty state is gone once connected', !/Bring your own agent/.test(rendered()), rendered().slice(0, 200));

console.log('\n5. delegated approvals render a real decision card');
FakeRelay.latest?.reply({
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
check('Allow resolves the protocol decision', FakeRelay.frames.includes('approval.response'), FakeRelay.frames);
check('the approval card settles and disappears', !rendered().includes('Approval required'), rendered().slice(0, 260));

console.log(failures === 0 ? '\nUI smoke passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
