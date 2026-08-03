/** Security check for the hosted-wallet popup's postMessage trust boundary. */
import { Window } from 'happy-dom';
import { WALLET_CHANNEL, startWalletHandshake, type WalletOutbound } from '../wallet/src/handshake.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const popup = new Window({ url: 'https://wallet.test/connect' });
const replies: Array<{ message: unknown; targetOrigin: string }> = [];
const opener = {
  postMessage(message: unknown, targetOrigin: string) {
    replies.push({ message, targetOrigin });
  },
};
const attacker = { postMessage() {} };
Object.defineProperty(popup, 'opener', { value: opener, configurable: true });

const requests: Array<{ origin: string; reply: (message: WalletOutbound) => void }> = [];
const stop = startWalletHandshake(
  (bound) => requests.push({ origin: bound.origin, reply: bound.reply }),
  popup as unknown as Parameters<typeof startWalletHandshake>[1],
);

const request = {
  id: 'request_1',
  delegate: 'a'.repeat(64),
  // Deliberately hostile: this must never override MessageEvent.origin.
  origin: 'https://payload-spoof.test',
  surface: { name: 'Inkwell' },
  tools: [
    {
      name: 'inkwell.document.write',
      description: 'Write the document',
      inputSchema: { type: 'object' },
      requiresApproval: true,
    },
  ],
  alwaysAsk: ['inkwell.document.write'],
};

const dispatch = (origin: string, source: unknown, body = request) => {
  popup.dispatchEvent(
    new popup.MessageEvent('message', {
      origin,
      source: source as never,
      data: { e: WALLET_CHANNEL, t: 'connect.request', request: body },
    }),
  );
};

console.log('wallet popup handshake');
dispatch('https://merchant.test', opener);
check('the first valid opener request binds exactly once', requests.length === 1, requests.length);
check('the requesting origin comes from MessageEvent.origin', requests[0]?.origin === 'https://merchant.test', requests[0]);
check('a payload origin is ignored', requests[0]?.origin !== request.origin, requests[0]);
check('the acknowledgement uses the exact bound targetOrigin', replies[0]?.targetOrigin === 'https://merchant.test', replies);

dispatch('https://attacker.test', opener);
dispatch('https://merchant.test', attacker);
check('another origin is ignored after binding', requests.length === 1 && replies.length === 1, { requests, replies });

dispatch('https://merchant.test', opener);
check('a retry is acknowledged but does not re-run the request', requests.length === 1 && replies.length === 2, {
  requests: requests.length,
  replies: replies.length,
});

requests[0]?.reply({ e: WALLET_CHANNEL, t: 'connect.error', id: request.id, message: 'test' });
check('every popup reply uses the same exact targetOrigin', replies.every((reply) => reply.targetOrigin === 'https://merchant.test'), replies);

stop();
console.log(failures === 0 ? '\nwallet popup check passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
