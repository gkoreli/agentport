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

export interface ConnectModal {
  status(text: string, error?: boolean): void;
  close(): void;
  /** Rejects if the user dismisses the dialog. */
  cancelled: Promise<never>;
}

export function openConnectModal(code: string, surfaceName: string, host: HTMLElement = document.body): ConnectModal {
  const mountHost = document.createElement('div');
  host.append(mountHost);
  const root = mountHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = CSS;
  const target = document.createElement('div');
  root.append(style, target);

  const label = signal(code);
  const status = signal('waiting for you to approve…');
  const failed = signal(false);
  const pending = signal(true);

  let reject: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_, rejectFn) => {
    reject = rejectFn;
  });

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      label.value = 'copied';
      setTimeout(() => (label.value = code), 700);
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
          <p>
            Paste this code where your agent is running. ${surfaceName} never sees your key, your
            model, or anything else your agent can do.
          </p>
          <div class="code" title="click to copy" @click=${copy}>${label}</div>
          <p class="hint">In your terminal, at the <b>Paste a connect code</b> prompt.</p>
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
    status: (text, error) => {
      status.value = text;
      failed.value = Boolean(error);
      pending.value = false;
    },
    close: () => mountHost.remove(),
    cancelled,
  };
}
