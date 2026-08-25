/**
 * Which protocol version is a relay speaking?
 *
 * There is deliberately no version endpoint. The relay is not a service that
 * describes itself; it is a router that refuses what it cannot honour, and
 * `Hello.v` is `display(1, 32)` rather than a literal for exactly this reason
 * — the comment on it says so: "the relay judges the version itself so an
 * incompatible peer gets a clear 'unsupported version' error instead of a
 * schema rejection."
 *
 * So the way to ask is to offer a version no relay will ever have and read the
 * refusal, which names its own: `relay speaks agentport/N`
 * (`packages/relay/src/core.ts#handle`). That is a real answer from the real
 * code path a real endpoint takes, not a status string somebody remembered to
 * update.
 *
 * Exit codes, because this is also usable in a script:
 *   0  answered, and it matches this tree's PROTOCOL_VERSION
 *   1  answered, and it does NOT match — a partially shipped release
 *   2  unreachable, or no answer within the deadline
 *   3  answered something this probe does not understand
 *
 * Every path is bounded. A relay that accepts the socket and then says nothing
 * is indistinguishable from a slow one, and nobody waits to find out.
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../packages/protocol/src/messages.js';
import { canonicalJson } from '../packages/protocol/src/crypto.js';

const DEADLINE_MS = 10_000;
/** No relay speaks this, which is the point: the refusal carries the answer. */
const IMPOSSIBLE_VERSION = 'probe';

const target = process.argv[2] ?? 'wss://agentport.gogakoreli.workers.dev/relay';

const finish = (lines: string[], code: number): never => {
  console.log(lines.join('\n'));
  process.exit(code);
};

const socket = new WebSocket(target);
const timer = setTimeout(() => {
  socket.terminate();
  finish([`${target}`, `  no answer within ${DEADLINE_MS}ms — the socket opened but the relay never replied`], 2);
}, DEADLINE_MS);

socket.on('open', () => {
  socket.send(canonicalJson({ role: 'client', t: 'hello', v: IMPOSSIBLE_VERSION }));
});

socket.on('message', (raw: Buffer | string) => {
  clearTimeout(timer);
  socket.close();

  let frame: unknown;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    finish([`${target}`, `  reply was not JSON: ${raw.toString().slice(0, 200)}`], 3);
  }

  const message = typeof frame === 'object' && frame !== null ? String((frame as { message?: unknown }).message ?? '') : '';
  const spoken = /agentport\/\d+/.exec(message)?.[0];
  if (!spoken) {
    finish([`${target}`, `  unexpected reply: ${JSON.stringify(frame).slice(0, 300)}`], 3);
  }

  const agrees = spoken === PROTOCOL_VERSION;
  finish(
    [
      `${target}`,
      `  relay speaks   ${spoken}`,
      `  this tree wants ${PROTOCOL_VERSION}`,
      '',
      agrees
        ? '  they agree — an endpoint built from this tree can attach.'
        : '  MISMATCH. A wire release is lockstep, so this means the relay, the site\n' +
          '  bundle, the hosted wallet and the CLI are not all from one commit yet.\n' +
          '  See docs/RELEASING.md.',
    ],
    agrees ? 0 : 1,
  );
});

socket.on('error', (error: Error) => {
  clearTimeout(timer);
  finish([`${target}`, `  unreachable — ${error.message}`], 2);
});
