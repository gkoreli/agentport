/**
 * Acceptance harness for the strict wire boundary (ADR-019 Gate B §1).
 *
 * Four gates, all of which must hold for the boundary to count as evidence:
 *
 *   1. fixtures  — every case in scripts/fixtures/wire/*.json behaves exactly
 *                  as declared: ok frames decode (and survive encode→decode
 *                  unchanged), violation cases throw WireViolation with the
 *                  exact expected code.
 *   2. coverage  — every FRAME_SCHEMAS type has ≥1 ok and ≥3 failure cases.
 *   3. bounds    — the pre-parse and structural guards fire programmatically.
 *   4. sealing   — openSealed enforces direction, session binding, and the
 *                  plaintext bound, using the real channel crypto.
 *
 * Failure output is restricted to file names, case names, expectation labels,
 * and WireViolation code/path — never bytes from a frame (ADR-019 §1: nothing
 * attacker-controlled reaches logs). An alternate fixtures directory may be
 * passed as argv[2] so the harness mechanics can be exercised against a
 * scratch corpus without touching the real evidence set.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { encrypt } from '../packages/protocol/src/channel.js';
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_FRAME_CHARS,
  MAX_SEALED_PLAINTEXT_BYTES,
  MAX_TEXT_CHARS,
} from '../packages/protocol/src/limits.js';
import {
  AGENT_SEALABLE,
  CLIENT_SEALABLE,
  FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  WIRE_FINGERPRINT,
  wireFingerprint,
  type Frame,
  type SessionFrame,
} from '../packages/protocol/src/messages.js';
import { VIOLATION_CODES, WireViolation, type ViolationCode } from '../packages/protocol/src/schema.js';
import {
  deriveSealChannel,
  generateSealKeyPair,
  openSealed,
  seal,
  type SealedFrame,
} from '../packages/protocol/src/seal.js';
import { canonicalJson } from '../packages/protocol/src/crypto.js';
import { decodeFrame, encodeFrame } from '../packages/protocol/src/wire.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/**
 * Taken from schema.ts rather than restated: a copied list silently rots into
 * a check that passes because it no longer knows what it is checking.
 */
const KNOWN_CODES = new Set<string>(VIOLATION_CODES);

/**
 * The only rendering of a caught error: WireViolation's closed-set code and
 * schema-derived path are safe to print; anything else is reduced to its
 * constructor name because its message may quote input bytes.
 */
function describeError(err: unknown): string {
  if (err instanceof WireViolation) return err.path === '' ? err.code : `${err.code} at ${err.path}`;
  return err instanceof Error ? err.name : typeof err;
}

// --- 1. fixture suite --------------------------------------------------------

interface FixtureCase {
  name?: unknown;
  expect?: unknown;
  frame?: unknown;
  raw?: unknown;
}

const fixturesDir = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('./fixtures/wire/', import.meta.url));

console.log(`1. fixture suite (${fixturesDir})`);

let files: string[] = [];
try {
  files = readdirSync(fixturesDir).filter((file) => file.endsWith('.json')).sort();
} catch (err) {
  // No directory means the coverage gate below cannot hold either; surface it
  // as its own failure so the cause is unambiguous.
  check('fixtures directory is readable', false, describeError(err));
}

const perType = new Map<string, { pass: number; total: number }>();
const coverage = new Map<string, { ok: number; fail: number }>();
const caseFailures: string[] = [];

function caseFail(file: string, name: string, message: string): void {
  caseFailures.push(`${file} :: ${name} — ${message}`);
}

for (const file of files) {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
  } catch {
    caseFail(file, '(file)', 'not valid JSON');
    continue;
  }
  const fixture = doc as { type?: unknown; cases?: unknown };
  if (typeof fixture.type !== 'string' || !Array.isArray(fixture.cases)) {
    caseFail(file, '(file)', 'missing "type" or "cases"');
    continue;
  }
  const type = fixture.type;
  if (!Object.prototype.hasOwnProperty.call(FRAME_SCHEMAS, type)) {
    // A fixture for a type the registry no longer knows is stale evidence.
    caseFail(file, '(file)', 'declares a frame type absent from FRAME_SCHEMAS');
    continue;
  }
  if (basename(file, '.json') !== type) {
    caseFail(file, '(file)', `filename does not match declared type "${type}"`);
  }

  const stats = perType.get(type) ?? { pass: 0, total: 0 };
  perType.set(type, stats);
  const cov = coverage.get(type) ?? { ok: 0, fail: 0 };
  coverage.set(type, cov);

  for (const entry of fixture.cases as FixtureCase[]) {
    stats.total++;
    const name = typeof entry.name === 'string' ? entry.name : '(unnamed)';
    const expect = entry.expect;
    if (typeof expect !== 'string' || (expect !== 'ok' && !KNOWN_CODES.has(expect))) {
      caseFail(file, name, 'invalid "expect"');
      continue;
    }
    let input: string;
    if (typeof entry.raw === 'string') {
      input = entry.raw;
    } else if (entry.frame !== undefined) {
      // The wire form is canonicalJson (sorted keys), not JSON.stringify —
      // fixture objects may be written in any key order.
      input = canonicalJson(entry.frame);
    } else {
      caseFail(file, name, 'needs "frame" or "raw"');
      continue;
    }

    if (expect === 'ok') {
      cov.ok++;
      let decoded: Frame;
      try {
        decoded = decodeFrame(input);
      } catch (err) {
        caseFail(file, name, `expected ok, got ${describeError(err)}`);
        continue;
      }
      if (decoded.t !== type) {
        caseFail(file, name, `decoded as "${decoded.t}"`);
        continue;
      }
      // Canonical idempotence: what we re-encode must decode back to the
      // same frame — the rebuilt object is itself a legal wire form.
      try {
        const again = decodeFrame(encodeFrame(decoded));
        if (!isDeepStrictEqual(again, decoded)) {
          caseFail(file, name, 'encode→decode round-trip diverged');
          continue;
        }
      } catch (err) {
        caseFail(file, name, `re-encoded frame failed to decode: ${describeError(err)}`);
        continue;
      }
      stats.pass++;
    } else {
      cov.fail++;
      try {
        decodeFrame(input);
        caseFail(file, name, `expected ${expect}, but the frame decoded`);
      } catch (err) {
        if (err instanceof WireViolation && err.code === expect) stats.pass++;
        else caseFail(file, name, `expected ${expect}, got ${describeError(err)}`);
      }
    }
  }
}

{
  const width = Math.max(0, ...[...perType.keys()].map((type) => type.length));
  for (const [type, stats] of [...perType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${stats.pass === stats.total ? 'ok  ' : 'FAIL'} ${type.padEnd(width)} ${stats.pass}/${stats.total}`);
  }
}
check('every fixture case behaves as declared', caseFailures.length === 0, caseFailures.length || undefined);
for (const line of caseFailures) console.log(`       ${line}`);

// --- 2. coverage gate (ADR-019 evidence) -------------------------------------

console.log('\n2. coverage over FRAME_SCHEMAS');
const frameTypes = Object.keys(FRAME_SCHEMAS);
const uncovered = frameTypes.filter((type) => {
  const cov = coverage.get(type);
  return !cov || cov.ok < 1 || cov.fail < 3;
});
check(
  `all ${frameTypes.length} frame types have ≥1 ok and ≥3 failure cases`,
  uncovered.length === 0,
  uncovered.length === 0 ? undefined : uncovered,
);

// --- 3. programmatic boundary suite ------------------------------------------

console.log('\n3. programmatic boundaries');

function expectViolation(label: string, input: string, code: ViolationCode): void {
  try {
    decodeFrame(input);
    check(label, false, 'decoded without error');
  } catch (err) {
    check(label, err instanceof WireViolation && err.code === code, describeError(err));
  }
}

expectViolation('a frame over MAX_FRAME_CHARS is rejected before parsing', 'x'.repeat(MAX_FRAME_CHARS + 1), 'oversize');
expectViolation('syntactically broken JSON is bad_json', '{"t":', 'bad_json');
expectViolation('a top-level array is wrong_type', '[]', 'wrong_type');
expectViolation('a top-level string is wrong_type', '"hello"', 'wrong_type');
expectViolation('an unregistered t is unknown_type', '{"t":"no.such.frame"}', 'unknown_type');

{
  const probe = {
    t: 'enc',
    s: 'sess-bounds',
    n: '0'.repeat(48),
    c: 'a'.repeat((MAX_CIPHERTEXT_BYTES + 1) * 2),
  };
  const wireForm = canonicalJson(probe);
  // Guards the guard: the probe must trip the ciphertext bound, not the outer
  // frame bound, or the check silently tests the wrong limit.
  check('the oversized-enc probe fits under MAX_FRAME_CHARS', wireForm.length <= MAX_FRAME_CHARS, wireForm.length);
  expectViolation('enc ciphertext over MAX_CIPHERTEXT_BYTES is too_long', wireForm, 'too_long');
}

// --- 4. sealed path -----------------------------------------------------------

console.log('\n4. sealed path (openSealed)');
{
  const sid = 'sess-wire-check';
  const clientKeys = generateSealKeyPair();
  const agentKeys = generateSealKeyPair();
  // Fresh directional state per sub-case: counters advance in lockstep, so
  // reusing one channel across independent probes would entangle them.
  const channels = () => ({
    client: deriveSealChannel(clientKeys.secretKey, agentKeys.publicKey, sid, 'client'),
    agent: deriveSealChannel(agentKeys.secretKey, clientKeys.publicKey, sid, 'agent'),
  });
  const prompt: SessionFrame = { t: 'prompt', s: sid, id: 'p1', text: 'hello from the page' };

  {
    const ch = channels();
    const sealedPrompt = seal(ch.client.send, prompt);
    const opened = openSealed(ch.agent.receive, sealedPrompt, 'client');
    check('a client-sealed prompt opens with from=client', isDeepStrictEqual(opened, prompt));
  }

  {
    const ch = channels();
    const sealedPrompt = seal(ch.client.send, prompt);
    try {
      openSealed(ch.agent.receive, sealedPrompt, 'agent');
      check('a prompt presented as agent traffic throws forbidden', false, 'opened');
    } catch (err) {
      check(
        'a prompt presented as agent traffic throws forbidden',
        err instanceof WireViolation && err.code === 'forbidden',
        describeError(err),
      );
    }
  }

  {
    // The session id is AEAD associated data, so rewriting the envelope `s`
    // fails authentication at decrypt — the inner mismatch check is
    // unreachable by envelope tampering. That failure class is a plain Error
    // (unauthenticated garbage an on-path relay could inject), deliberately
    // NOT a session-fatal WireViolation, and it must not advance the channel.
    const ch = channels();
    const sealedPrompt = seal(ch.client.send, prompt);
    const tampered: SealedFrame = { ...sealedPrompt, s: 'sess-other' };
    let outcome: unknown = null;
    try {
      openSealed(ch.agent.receive, tampered, 'client');
    } catch (err) {
      outcome = err;
    }
    check(
      'rewriting the envelope session id fails AEAD authentication',
      outcome instanceof Error && !(outcome instanceof WireViolation),
      describeError(outcome),
    );
    try {
      const openedAfter = openSealed(ch.agent.receive, sealedPrompt, 'client');
      check('the channel survives the tampered envelope intact', isDeepStrictEqual(openedAfter, prompt));
    } catch (err) {
      check('the channel survives the tampered envelope intact', false, describeError(err));
    }
  }

  {
    // The nonce is compared BEFORE the AEAD tag, so anyone on the path can
    // forge a mismatched one without a key. It must therefore be droppable,
    // never a WireViolation — the endpoints treat a WireViolation as proof of
    // peer misbehaviour and end the session, which would hand a passive
    // intermediary a kill switch over any session it can see.
    const ch = channels();
    const prompt: SessionFrame = { t: 'prompt', s: sid, id: 'p_nonce', text: 'still here' };
    const sealedPrompt = seal(ch.client.send, prompt);
    for (const [label, nonce] of [
      ['a future nonce', `${'0'.repeat(32)}${(99n).toString(16).padStart(16, '0')}`],
      ['a past nonce', `${'0'.repeat(32)}${'f'.repeat(16)}`],
      ['a structurally odd nonce', 'f'.repeat(48)],
    ] as const) {
      let thrown: unknown;
      try {
        openSealed(ch.agent.receive, { ...sealedPrompt, n: nonce }, 'client');
      } catch (err) {
        thrown = err;
      }
      check(
        `${label} is droppable, not a peer violation`,
        thrown instanceof Error && !(thrown instanceof WireViolation),
        describeError(thrown),
      );
    }
    try {
      const still = openSealed(ch.agent.receive, sealedPrompt, 'client');
      check('the channel still opens the authentic frame afterwards', isDeepStrictEqual(still, prompt));
    } catch (err) {
      check('the channel still opens the authentic frame afterwards', false, describeError(err));
    }
  }

  {
    // seal() copies frame.s into the envelope, so a well-behaved peer cannot
    // produce an inner/outer mismatch — reach the check by playing the hostile
    // peer directly: encrypt an inner frame for another session under THIS
    // session's associated data. The AD string restates seal.ts's internal
    // format on purpose; a hostile peer re-implements the sealing layer by
    // definition, and if the format drifts this check fails loudly instead of
    // silently testing nothing.
    const ch = channels();
    const foreign: SessionFrame = { t: 'prompt', s: 'sess-other', id: 'p2', text: 'wrong room' };
    const hostile = encrypt(
      ch.client.send,
      new TextEncoder().encode(canonicalJson(foreign)),
      new TextEncoder().encode(`agentport-seal-v1:${sid}`),
    );
    const mismatched: SealedFrame = { t: 'enc', s: sid, n: hostile.nonce, c: hostile.ciphertext };
    try {
      openSealed(ch.agent.receive, mismatched, 'client');
      check('an inner/outer session id mismatch throws WireViolation mismatch', false, 'opened');
    } catch (err) {
      check(
        'an inner/outer session id mismatch throws WireViolation mismatch',
        err instanceof WireViolation && err.code === 'mismatch',
        describeError(err),
      );
    }
  }

  {
    const ch = channels();
    // Sender side, two ways a frame can be unsendable — both must be caught
    // BEFORE encrypt() advances the send counter, since a frame the receiver
    // would reject must fail here as a local bug, not there as a teardown.
    const counterBefore = ch.client.send.nonce;
    try {
      seal(ch.client.send, { t: 'prompt', s: sid, id: 'p3', text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
      check('seal() refuses a frame its own schema rejects', false, 'sealed');
    } catch (err) {
      check(
        'seal() refuses a frame its own schema rejects',
        err instanceof WireViolation && err.code === 'too_long' && ch.client.send.nonce === counterBefore,
        describeError(err),
      );
    }
    // Schema-valid, frame-legal, but past the sealed-plaintext bound: four
    // maximal history entries sit between MAX_SEALED_PLAINTEXT_BYTES and
    // MAX_FRAME_CHARS, so only the sealing bound can catch it.
    const bulky: SessionFrame = {
      t: 'history',
      s: sid,
      entries: Array.from({ length: 4 }, () => ({ role: 'agent' as const, text: 'y'.repeat(MAX_TEXT_CHARS), at: 1_800_000_000_000 })),
    };
    try {
      seal(ch.agent.send, bulky);
      check('seal() refuses an oversized plaintext before encrypting', false, 'sealed');
    } catch (err) {
      check(
        'seal() refuses an oversized plaintext before encrypting',
        err instanceof WireViolation && err.code === 'oversize' && ch.agent.send.nonce === 0n,
        describeError(err),
      );
    }
    // Receiver side: a hostile peer that skips seal() and encrypts the
    // oversized plaintext directly still dies at openSealed's independent
    // post-decrypt bound (ADR-019 §1: ciphertext and plaintext bounded
    // independently) — session-fatal, since the receive counter advanced.
    const hostileBig = encrypt(
      ch.client.send,
      new TextEncoder().encode(canonicalJson(bulky)),
      new TextEncoder().encode(`agentport-seal-v1:${sid}`),
    );
    const sealedBig: SealedFrame = { t: 'enc', s: sid, n: hostileBig.nonce, c: hostileBig.ciphertext };
    try {
      openSealed(ch.agent.receive, sealedBig, 'client');
      check('a plaintext over MAX_SEALED_PLAINTEXT_BYTES throws WireViolation oversize', false, 'opened');
    } catch (err) {
      check(
        'a plaintext over MAX_SEALED_PLAINTEXT_BYTES throws WireViolation oversize',
        err instanceof WireViolation && err.code === 'oversize',
        describeError(err),
      );
    }
  }
}

// --- 5. registry and encoding properties --------------------------------------

console.log('\n5. registry and encoding properties');
{
  // A mis-filed registry entry ('delta' → the Thought schema, say) is invisible
  // to TypeScript: both sides are Schema<Frame>. Probe each entry with a frame
  // carrying only its own tag — whatever else it objects to, it must not be
  // that the tag itself is wrong.
  const misfiled: string[] = [];
  for (const [type, schema] of Object.entries(FRAME_SCHEMAS)) {
    try {
      schema({ t: type }, type);
    } catch (err) {
      if (err instanceof WireViolation && err.path === `${type}.t`) misfiled.push(type);
    }
  }
  check('every FRAME_SCHEMAS entry accepts its own type tag', misfiled.length === 0, misfiled);

  // The relay stamps identity onto a decoded frame and re-encodes it. That
  // must strip `viaConnect` (only the relay's own connect flow may assert it)
  // and must stay canonical for the next hop's decoder.
  const opened = decodeFrame(canonicalJson({
    t: 'session.open',
    s: 'sess_stamp',
    agent: 'a'.repeat(64),
    surface: { name: 'Surface', origin: 'https://surface.test' },
    grant: { tools: [], alwaysAsk: [], expiresAt: 1_800_000_000_000 },
    epk: 'b'.repeat(64),
    epkSig: 'c'.repeat(128),
    viaConnect: true,
  }));
  const stamped = encodeFrame({ ...opened, client: 'd'.repeat(64), viaConnect: undefined } as Frame);
  check('stamping strips viaConnect from the wire', !stamped.includes('viaConnect'));
  let restamped: Frame | undefined;
  try {
    restamped = decodeFrame(stamped);
  } catch (err) {
    check('a stamped frame is still canonical for the next hop', false, describeError(err));
  }
  if (restamped) {
    check('a stamped frame is still canonical for the next hop', encodeFrame(restamped) === stamped);
  }

  // Ambiguous number spellings must not survive: JSON.parse loses precision
  // past 2^53, so the re-encoded form differs and the frame is rejected.
  const ambiguous = '{"nonce":"' + 'a'.repeat(32) + '","t":"challenge","x":9007199254740993}';
  let ambiguousCode = 'accepted';
  try {
    decodeFrame(ambiguous);
  } catch (err) {
    ambiguousCode = err instanceof WireViolation ? err.code : 'other';
  }
  check('a number that cannot round-trip is non_canonical', ambiguousCode === 'non_canonical', ambiguousCode);
}

// --- 6. the version this wire declares ----------------------------------------

console.log('\n6. protocol version');
{
  // This suite had 500 fixture cases, a coverage gate over FRAME_SCHEMAS and two
  // exhaustiveness guards, and had never heard of the field the wire's
  // compatibility actually depends on. Three breaking changes landed in one day
  // under this harness with the version untouched, because the harness was
  // shaped around the problem as it existed BEFORE unknown keys began to reject
  // — which is what made an additive field a breaking change in the first place.
  // The lesson is not "add a check": when a new invariant appears, ask whether
  // the existing suite is still shaped like the problem.
  check('the protocol version is a legible pinned identifier', /^agentport\/\d+$/.test(PROTOCOL_VERSION), PROTOCOL_VERSION);

  // The pin this replaces could say the version had changed; it could not say
  // the version SHOULD have. This can. The fingerprint is recomputed from the
  // schemas on every run and covers every frame type and the full nested shape
  // of every field — so a widened bound, a new optional key, or a field buried
  // inside SessionDelegation all move it, and a wire change that forgot the
  // version is a red build instead of a confusing failure after auth.
  //
  // When this fails the fix is two edits, not one: bump PROTOCOL_VERSION and
  // record the new fingerprint. Recording the fingerprint alone is not a way
  // to silence it — that is the point of them being separate constants.
  check(
    'the wire matches the fingerprint recorded beside its version',
    wireFingerprint() === WIRE_FINGERPRINT,
    { recorded: WIRE_FINGERPRINT, actual: wireFingerprint() },
  );
}

// --- routers ------------------------------------------------------------------
//
// The last hop, and the one the type system cannot reach.
//
// `messages.ts` proves at compile time that a new content frame is in
// `FRAME_SCHEMAS`, in `SESSION_FRAME_TYPES`, and in exactly one of the sealable
// sets. Every one of those guards conspires to deliver it: it decodes, it
// unseals, it routes to the right session — and then it meets a `switch` that
// has no case for it and is dropped. All the ceremony upstream makes the frame
// look handled right up to the door.
//
// A `never` default in those routers would be the wrong fix and is deliberately
// not what this asserts. They are PARTIAL over the 45-frame union on purpose:
// an endpoint receives a subset, and AGENTS.md warns against making the
// origination sets total because partial is what makes them fail-closed. What
// must be total is narrower — every frame the peer may SEAL toward you is one
// you handle.
//
// Source-matched on `case 'x'`, which is fragile in the safe direction: someone
// restructuring a router away from a switch fails this loudly rather than
// silently, which is the failure this whole check exists to convert.
{
  const routers = [
    { role: 'daemon', file: 'packages/daemon/src/daemon.ts', expects: CLIENT_SEALABLE, from: 'CLIENT_SEALABLE' },
    { role: 'client session', file: 'packages/client/src/session.ts', expects: AGENT_SEALABLE, from: 'AGENT_SEALABLE' },
  ];
  for (const router of routers) {
    const source = readFileSync(new URL(`../${router.file}`, import.meta.url), 'utf8');
    const handled = new Set([...source.matchAll(/case '([a-z][a-z._]*)'/g)].map((m) => m[1] as string));
    const missing = [...router.expects].filter((type) => !handled.has(type));
    check(
      `the ${router.role} handles every frame in ${router.from}`,
      missing.length === 0,
      { missing, file: router.file },
    );
  }
}

// --- summary ------------------------------------------------------------------

const caseTotal = [...perType.values()].reduce((sum, stats) => sum + stats.total, 0);
console.log(
  `\n${failures === 0
    ? `all checks passed (${caseTotal} fixture cases across ${perType.size} frame types)`
    : `${failures} check(s) failed`}`,
);
process.exit(failures === 0 ? 0 : 1);
