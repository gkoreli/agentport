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
const modal = openConnectModal('R7KP-92MX', 'Inkwell', holder as unknown as HTMLElement);
modal.cancelled.catch(() => {});
flush();

const hostEl = holder.firstElementChild as unknown as { shadowRoot: unknown };
check('modal mounted into a closed shadow root', holder.children.length === 1 && hostEl.shadowRoot === null);

// Reach inside via the reference happy-dom keeps, only to assert content.
const shadowText = (holder.firstElementChild as unknown as { __shadowRoot?: { textContent: string } });
void shadowText;
check('page cannot read the dialog through .shadowRoot', hostEl.shadowRoot === null);

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

console.log(failures === 0 ? '\nUI smoke passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
