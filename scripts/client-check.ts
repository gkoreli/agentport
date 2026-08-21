/**
 * Frame correlation, asserted directly — no wallet, no socket, no relay.
 *
 * `FrameCorrelator` used to be four private methods and a table inside
 * `AgentWallet`, and both properties it exists to hold had already been bugs:
 *
 *   1. a waiter registered under two types, answered by one, left a stale twin
 *      under the other that silently ate the next frame of that type and
 *      starved every waiter behind it;
 *   2. a refusal frame no call site had listed reached nobody, so the caller
 *      waited forever on a question that had already been answered.
 *
 * Neither was reachable without standing up a relay and a daemon, so neither
 * had ever been asserted. Here they are one function call each.
 *
 * Every wait in this file is bounded. A correlation bug's natural shape is a
 * promise that never settles, and a check that hangs on the bug it targets is
 * not a check — a hang is indistinguishable from slowness and nobody waits to
 * find out.
 */

import { FrameCorrelator } from '../packages/client/src/index.js';
import { createLogger, type Frame, type LogEntry } from '../packages/protocol/src/index.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

/** How long any promise here may take before it counts as never settling. */
const DEADLINE_MS = 100;

type Outcome<T> = { state: 'resolved'; value: T } | { state: 'rejected'; message: string } | { state: 'pending' };

/**
 * Settle-or-give-up. Both branches are observed, so a promise that hangs
 * becomes a reported failure instead of a stalled process, and a rejection is
 * always handled — an unhandled one would take the run down somewhere else
 * entirely, blaming the wrong line.
 */
async function outcome<T>(promise: Promise<T>, ms = DEADLINE_MS): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Outcome<T> => ({ state: 'resolved', value }),
        (error: unknown): Outcome<T> => ({ state: 'rejected', message: error instanceof Error ? error.message : String(error) }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const entries: LogEntry[] = [];
const logged = (fragment: string): boolean => entries.some((entry) => entry.message.includes(fragment));
/** A fresh correlator per section: "the oldest plausible request" is only a
 *  meaningful claim when the section owns every request in flight. */
const correlator = () => {
  entries.length = 0;
  return new FrameCorrelator(createLogger('client.check', { sink: (entry) => entries.push(entry) }));
};

const OPENED: Frame = {
  t: 'session.opened',
  s: 'sess_check',
  agentName: 'Check Agent',
  runtime: 'demo',
  ownTools: true,
  epk: 'a'.repeat(64),
  epkSig: 'b'.repeat(128),
};
const DENIED: Frame = { t: 'session.denied', s: 'sess_check', reason: 'not_your_agent' };
const AGENTS: Frame = { t: 'agents', agents: [] };
const RELAY_ERROR: Frame = { t: 'error', code: 'forbidden', message: 'not allowed' };

console.log('1. a settled waiter leaves no twin behind');
{
  const frames = correlator();
  // One waiter, two types — the shape every session.open takes: success or
  // refusal, whichever comes first.
  const opening = frames.expect('session.opened', 'session.denied');
  check('the reply settles the waiter', frames.resolve(OPENED));
  const opened = await outcome(opening);
  check('and the caller gets the frame it waited for', opened.state === 'resolved' && opened.value.t === 'session.opened', opened);

  // THE BUG: the entry filed under the type that did NOT answer used to stay
  // in the queue. It is already settled, so the next frame of that type is
  // handed to it, resolves nothing, and the waiter actually waiting for it
  // never hears anything.
  const refusing = frames.expect('session.denied');
  check('a later refusal is claimed by something', frames.resolve(DENIED));
  const refused = await outcome(refusing);
  check(
    'the refusal reaches the LIVE waiter, not a settled twin',
    refused.state === 'resolved' && refused.value.t === 'session.denied',
    refused,
  );
}

console.log('\n2. a timed-out waiter is withdrawn, not left to swallow a late reply');
{
  const frames = correlator();
  const timedOut = await outcome(frames.expectTimed('agents.list', 10, 'agents'), 300);
  check(
    'the deadline fails the caller instead of hanging',
    timedOut.state === 'rejected' && /agents\.list handshake timed out after 10ms/.test(timedOut.message),
    timedOut,
  );

  // The reply the retry is waiting for. If the timed-out waiter is still in
  // the queue it takes this frame and the retry hangs — a deadline that turns
  // one slow request into a permanently broken client.
  const retry = frames.expect('agents');
  check('the late reply is claimed', frames.resolve(AGENTS));
  const answered = await outcome(retry);
  check('and it reaches the retry, not the abandoned waiter', answered.state === 'resolved', answered);
}

console.log('\n3. a refusal nobody listed still answers the request it refuses');
{
  const frames = correlator();
  // Deliberately lists only the success type — the mistake that is always one
  // call site away, because the reply set is written out by hand per request.
  const opening = frames.expect('session.opened');
  check('the unlisted refusal is not dropped on the floor', frames.resolve(DENIED));
  const refused = await outcome(opening);
  check(
    'the caller is told, rather than left waiting on an answered question',
    refused.state === 'rejected' && refused.message === 'connection declined: not_your_agent',
    refused,
  );
  // A backstop that works silently is a backstop nobody knows they depend on.
  check('and the backstop says it fired', logged('a refusal was not in its waiter list'), entries.map((e) => e.message));
}

console.log('\n4. an error frame fails the oldest request when nobody claims it');
{
  const frames = correlator();
  const first = frames.expect('agents');
  const second = frames.expect('pair.offer');
  check('the error is attributed to a request', frames.resolve(RELAY_ERROR));
  const failed = await outcome(first);
  check('the oldest request carries the relay code and message', failed.state === 'rejected' && failed.message === 'forbidden: not allowed', failed);
  const survivor = await outcome(second);
  check('and only one request pays for it', survivor.state === 'pending', survivor);
}

console.log('\n5. nothing in flight survives a cancel or a close');
{
  const frames = correlator();
  const abandoned = frames.register('agents');
  abandoned.cancel();
  check('a cancelled waiter no longer claims its frame', frames.resolve(AGENTS) === false);
  check('and it stays unsettled rather than resolving late', (await outcome(abandoned.promise)).state === 'pending');
}
{
  const frames = correlator();
  const opening = frames.register('session.opened', 'session.denied');
  const listing = frames.register('agents');
  frames.close('wallet_closed');
  const openFailed = await outcome(opening.promise);
  const listFailed = await outcome(listing.promise);
  check(
    'close fails everything in flight',
    openFailed.state === 'rejected' &&
      openFailed.message === 'request abandoned: wallet_closed' &&
      listFailed.state === 'rejected',
    { openFailed, listFailed },
  );
  // Two callers, three queue entries: a waiter filed under two types must be
  // failed ONCE. The same stale-twin rule, at teardown.
  const discarded = entries.find((entry) => entry.message.includes('discarding requests'));
  check('a two-type waiter is one abandoned request, not two', discarded?.data?.['pending'] === 2, discarded?.data);
  check('and nothing is left to claim a later frame', frames.resolve(OPENED) === false);
}

console.log(failures === 0 ? '\nclient check passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
