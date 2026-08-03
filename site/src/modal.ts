import { html, signal, when } from '@nisli/core';

/**
 * The connect modal, built with nisli's template layer.
 *
 * Deliberately `html` rather than `component()`: this renders inside arbitrary
 * third-party pages, and `component()` registers a custom-element tag name in
 * a registry the embedding page can also reach. A tag the page could pre-empt
 * is a tag that could impersonate this dialog. nisli's template layer owns its
 * DOM outright, so the trust story doesn't rest on registry isolation.
 *
 * (The same split is documented in packages/extension for the same reason.)
 */

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
.back { position: fixed; inset: 0; background: rgba(6,8,11,.74); display: grid; place-items: center; z-index: 2147483647; }
.card { width: min(430px, 92vw); background: #14171c; color: #e6e8ec; border: 1px solid #262c36; border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden; }
.body { padding: 24px; text-align: center; }
h3 { margin: 0 0 6px; font-size: 16px; font-weight: 650; }
p { margin: 0 0 18px; color: #8b94a3; font-size: 13px; line-height: 1.55; }
.code { font-family: ui-monospace, monospace; font-size: 15px; font-weight: 500; background: #0d0f12; border: 1px solid #262c36; border-radius: 10px; padding: 14px 16px; cursor: pointer; user-select: all; text-align: left; color: #cfe0ff; white-space: nowrap; overflow-x: auto; }
.code::before { content: "$ "; color: #4a5464; }
.code:hover { border-color: #7c9cff; }
.hint { font-size: 12px; margin: 11px 0 0; color: #6f7889; line-height: 1.5; }
.hint.alt { margin-top: 8px; padding-top: 9px; border-top: 1px solid #1c222b; color: #59616f; }
.hint b { color: #8b94a3; font-family: ui-monospace, monospace; }
.status { margin: 16px 0 0; font-size: 13px; color: #8b94a3; min-height: 18px; }
.status.err { color: #ff8080; }
.foot { display: flex; justify-content: space-between; align-items: center; padding: 13px 20px; border-top: 1px solid #222831; background: #101318; }
.brand { font-size: 11px; color: #6f7889; letter-spacing: .3px; }
button { font: inherit; font-size: 13px; font-weight: 500; border: 1px solid #2b323d; background: transparent; color: #e6e8ec; border-radius: 8px; padding: 7px 14px; cursor: pointer; }
.spin { display: inline-block; width: 11px; height: 11px; border: 2px solid #2f3846; border-top-color: #7c9cff; border-radius: 50%; animation: s .8s linear infinite; vertical-align: -1px; margin-right: 7px; }
@keyframes s { to { transform: rotate(360deg); } }
`;

export interface ConnectModal {
  /** Called once the relay hands back a code. */
  setCode(code: string): void;
  status(text: string, error?: boolean): void;
  close(): void;
  /** Rejects if the user dismisses the dialog. */
  cancelled: Promise<never>;
}

/** What a visitor should literally type. Kept in one place so it can't drift. */
export function connectCommand(code: string): string {
  return `npx @gkoreli/agentport connect ${code}`;
}

/**
 * Opened *immediately* on click, before the relay is even dialled. Anything
 * that goes wrong after this point has somewhere visible to be reported —
 * the previous version only appeared once a code existed, so a failure on the
 * way there looked exactly like the button doing nothing.
 */
export function openConnectModal(surfaceName: string, host: HTMLElement = document.body): ConnectModal {
  const mountHost = document.createElement('div');
  host.append(mountHost);
  const root = mountHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = CSS;
  const target = document.createElement('div');
  root.append(style, target);

  let command = '';
  const label = signal('…');
  const rawCode = signal('');
  const status = signal('contacting relay…');
  const failed = signal(false);
  const pending = signal(true);
  const ready = signal(false);

  let reject: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_, rejectFn) => {
    reject = rejectFn;
  });

  const copy = () => {
    if (!command) return;
    void navigator.clipboard?.writeText(command).then(() => {
      label.value = 'copied to clipboard';
      setTimeout(() => (label.value = command), 900);
    });
  };

  const dismiss = () => {
    mountHost.remove();
    reject(new Error('cancelled by user'));
  };

  html`
    <div class="back">
      <div class="card">
        <div class="body">
          <h3>Connect your agent</h3>
          <p>Run this in your terminal, then approve there.</p>
          <div class="code" title="click to copy" @click=${copy}>${label}</div>
          ${when(
            ready,
            () => html`<p class="hint">
                Click to copy. Your agent stays on your machine — ${surfaceName} never sees your
                key, your model, or anything else it can do.
              </p>
              <p class="hint alt">Already have an agent running? Paste <b>${rawCode}</b> at its prompt.</p>`,
          )}
          <div class="status" class:err=${failed}>
            ${when(pending, () => html`<span class="spin"></span>`)}${status}
          </div>
        </div>
        <div class="foot">
          <span class="brand">AgentPort</span>
          <button @click=${dismiss}>Cancel</button>
        </div>
      </div>
    </div>
  `.mount(target);

  return {
    setCode: (code) => {
      command = connectCommand(code);
      label.value = command;
      rawCode.value = code;
      ready.value = true;
      status.value = 'waiting for you to approve…';
    },
    status: (text, error) => {
      status.value = text;
      failed.value = Boolean(error);
      pending.value = false;
    },
    close: () => mountHost.remove(),
    cancelled,
  };
}
