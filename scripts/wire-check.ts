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
import { ResumeError } from '../packages/client/src/wallet.js';
import {
  HISTORY_BUDGET_CHARS,
  boundHistory,
  boundString,
  textChunks,
} from '../packages/daemon/src/bounds.js';
import { encrypt } from '../packages/protocol/src/channel.js';
import {
  DELEGATION_DENIALS,
  SIGNER_UNKNOWN,
  delegationAuthorizes,
  type DelegationContext,
  type DelegationDenial,
} from '../packages/protocol/src/delegation.js';
import { SESSION_DENIAL_REASONS, isTerminalResumeDenial } from '../packages/protocol/src/denials.js';
import { grantWiderThan, isGated } from '../packages/protocol/src/grant.js';
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_DELEGATION_CLOCK_SKEW_MS,
  MAX_DELEGATION_LIFETIME_MS,
  MAX_ERROR_CHARS,
  MAX_FRAME_CHARS,
  MAX_HISTORY_ENTRIES,
  MAX_SEALED_PLAINTEXT_BYTES,
  MAX_TEXT_CHARS,
  TIMESTAMP_MAX,
  TIMESTAMP_MIN,
} from '../packages/protocol/src/limits.js';
import {
  AGENT_SEALABLE,
  CLIENT_SEALABLE,
  FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  WIRE_FINGERPRINT,
  wireFingerprint,
  type CapabilityGrant,
  type Frame,
  type HistoryEntry,
  type SessionDelegation,
  type SessionFrame,
} from '../packages/protocol/src/messages.js';
import { VIOLATION_CODES, WireViolation, type ViolationCode } from '../packages/protocol/src/schema.js';
import {
  deriveSealChannel,
  generateSealKeyPair,
  openSealed,
  seal,
  signEpk,
  verifyEpk,
  type SealedFrame,
} from '../packages/protocol/src/seal.js';
import {
  canonicalJson,
  generateKeyPair,
  hashGrant,
  sign,
  signDelegation,
  verify,
} from '../packages/protocol/src/crypto.js';
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

  // The wire fingerprint covers frame schemas, not the semantics of a signed
  // transcript: this change deliberately has no new frame field and therefore
  // does not move that fingerprint. Prove the semantic boundary directly. The
  // legacy signature is over the exact pre-v6, versionless transcript; if the
  // locally compiled version is removed from epkProofMessage, this rejection
  // becomes an acceptance and the check fails for the downgrade it names.
  const identity = generateKeyPair();
  const epk = generateSealKeyPair().publicKey;
  const scope = 'sess_version_proof';
  const binding = { mode: 'resume', agent: 'a'.repeat(64), token: 'legacy-token' };
  const currentSignature = signEpk(identity.secretKey, scope, epk, binding);
  const legacyMessage = `agentport-epk-v1:${canonicalJson({ scope, epk, binding })}`;
  const legacySignature = sign(identity.secretKey, legacyMessage);
  check(
    'a current v6 EPK proof verifies',
    verifyEpk(identity.publicKey, scope, epk, currentSignature, binding),
  );
  check(
    'the legacy versionless signature is valid for its historical transcript',
    verify(identity.publicKey, legacyMessage, legacySignature),
  );
  check(
    'v6 rejects a legacy versionless EPK proof',
    !verifyEpk(identity.publicKey, scope, epk, legacySignature, binding),
  );
}

// --- 7. the delegation judge ---------------------------------------------------
//
// Not a fixture suite: fixtures here are `decodeFrame` cases, and this rule is
// not a decode question — a delegation can be perfectly well-formed on the wire
// and still authorise nothing. It lived as three drifted copies (relay, daemon,
// page) for exactly that reason: no gate was shaped like it.

console.log('\n7. delegationAuthorizes');
{
  // A fixed clock inside the protocol's timestamp domain, so nothing here
  // depends on when the suite runs.
  const now = 1_800_000_000_000;
  const owner = generateKeyPair();
  const stranger = generateKeyPair();
  const agent = generateKeyPair();
  const page = generateKeyPair();
  const origin = 'https://judged.test';
  const grant: CapabilityGrant = { tools: [], alwaysAsk: [], expiresAt: now + 60 * 60 * 1000 };
  const otherGrant: CapabilityGrant = { ...grant, expiresAt: grant.expiresAt + 1000 };

  const body = {
    delegate: page.publicKey,
    agent: agent.publicKey,
    origin,
    grantHash: hashGrant(grant),
    issuedAt: now - 1000,
    expiresAt: now + 60 * 60 * 1000,
  };
  const sign_ = (over: Partial<typeof body> = {}): SessionDelegation =>
    signDelegation(owner.secretKey, { ...body, ...over });
  const valid = sign_();
  const context: DelegationContext = {
    owner: owner.publicKey,
    agent: agent.publicKey,
    delegate: page.publicKey,
    origin,
    grant,
    now,
  };

  check('a valid delegation authorizes', delegationAuthorizes(valid, context) === undefined,
    delegationAuthorizes(valid, context));

  // One case per member of the closed reason set, each violating exactly one
  // clause. Anything that fires for a reason other than its own is a clause
  // that overlaps another and would report the wrong cause in a log.
  const cases: { label: string; expect: DelegationDenial; delegation: SessionDelegation; context: DelegationContext }[] = [
    {
      label: 'a delegation naming another page key',
      expect: 'delegate',
      delegation: valid,
      context: { ...context, delegate: stranger.publicKey },
    },
    {
      label: 'a delegation replayed toward another agent',
      expect: 'agent',
      delegation: valid,
      context: { ...context, agent: stranger.publicKey },
    },
    {
      label: 'a delegation presented from another origin',
      expect: 'origin',
      delegation: valid,
      context: { ...context, origin: 'https://elsewhere.test' },
    },
    {
      label: 'a delegation presented with a grant it does not commit to',
      expect: 'grant',
      delegation: valid,
      context: { ...context, grant: otherGrant },
    },
    {
      label: 'a delegation living longer than MAX_DELEGATION_LIFETIME_MS',
      expect: 'lifetime',
      delegation: sign_({ expiresAt: body.issuedAt + MAX_DELEGATION_LIFETIME_MS + 1000 }),
      context,
    },
    {
      label: 'a delegation that expires before it is issued',
      expect: 'lifetime',
      delegation: sign_({ issuedAt: now + 1000, expiresAt: now + 1000 }),
      context,
    },
    {
      label: 'an expired delegation',
      expect: 'expired',
      delegation: sign_({ issuedAt: now - 120_000, expiresAt: now - 60_000 }),
      context,
    },
    {
      label: 'a delegation dated past the clock-skew tolerance',
      expect: 'not_yet_valid',
      delegation: sign_({
        issuedAt: now + MAX_DELEGATION_CLOCK_SKEW_MS + 1000,
        expiresAt: now + MAX_DELEGATION_CLOCK_SKEW_MS + 61_000,
      }),
      context,
    },
    {
      label: 'a delegation signed by anyone but the owner',
      expect: 'sig',
      delegation: signDelegation(stranger.secretKey, body),
      context,
    },
  ];

  const fired = new Set<string>();
  for (const one of cases) {
    const denial = delegationAuthorizes(one.delegation, one.context);
    fired.add(one.expect);
    check(`${one.label} → ${one.expect}`, denial === one.expect, denial ?? 'authorized');
  }
  // The registry guard: a reason nobody can produce is a reason nobody checks.
  const unfired = DELEGATION_DENIALS.filter((denial) => !fired.has(denial));
  check('every DELEGATION_DENIALS member has a case that produces it', unfired.length === 0, unfired);

  // The new clause's other side. Skew tolerance is not decoration: a browser a
  // few minutes fast must still be able to approve something.
  check(
    'a delegation dated forward WITHIN the skew tolerance still authorizes',
    delegationAuthorizes(
      sign_({
        issuedAt: now + MAX_DELEGATION_CLOCK_SKEW_MS - 1000,
        expiresAt: now + MAX_DELEGATION_CLOCK_SKEW_MS + 59_000,
      }),
      context,
    ) === undefined,
  );

  // The two stated weakenings, asserted as weakenings rather than trusted as
  // comments. Each judge's shorter conjunction is a parameter it passes, so
  // each is visible here — and so is the fact that the OTHER clauses still
  // apply to that judge.
  const { origin: _omitted, ...relayContext } = context;
  check(
    'the relay position (no origin) admits a delegation for another origin',
    delegationAuthorizes(sign_({ origin: 'https://elsewhere.test' }), relayContext) === undefined,
  );
  check(
    'the relay position still refuses that delegation for every other clause',
    delegationAuthorizes(sign_({ origin: 'https://elsewhere.test' }), {
      ...relayContext,
      delegate: stranger.publicKey,
    }) === 'delegate',
  );
  const pageContext: DelegationContext = { ...context, owner: SIGNER_UNKNOWN };
  check(
    'the page position (SIGNER_UNKNOWN) cannot detect a forged signature',
    delegationAuthorizes(signDelegation(stranger.secretKey, body), pageContext) === undefined,
  );
  check(
    'the page position still applies every clause it can',
    delegationAuthorizes(signDelegation(stranger.secretKey, { ...body, origin: 'https://elsewhere.test' }), pageContext) ===
      'origin',
  );

  // A judge that authenticated nobody must not accept an authority naming
  // somebody. This is the `!` at a call site, turned into a value.
  check(
    'an unauthenticated presenter matches no delegation',
    delegationAuthorizes(valid, { ...context, delegate: undefined }) === 'delegate',
  );
}

// --- 8. the gating rule --------------------------------------------------------

console.log('\n8. isGated');
{
  const plain = { name: 'site.read', description: '', inputSchema: {} };
  const flagged = { ...plain, name: 'site.write', requiresApproval: true };
  check('a tool gated by neither is not gated', isGated(plain, { alwaysAsk: [] }) === false);
  check('a tool gated only by requiresApproval is gated', isGated(flagged, { alwaysAsk: [] }) === true);
  check('a tool gated only by alwaysAsk is gated', isGated(plain, { alwaysAsk: ['site.read'] }) === true);
  check('a tool gated by both is gated', isGated(flagged, { alwaysAsk: ['site.write'] }) === true);
  check('alwaysAsk naming another tool does not gate this one', isGated(plain, { alwaysAsk: ['site.write'] }) === false);
  check('an absent alwaysAsk gates nothing by itself', isGated(plain, {}) === false);
  check('requiresApproval: false is not gated', isGated({ ...plain, requiresApproval: false }, {}) === false);
}

// --- 8b. grantWiderThan --------------------------------------------------------
//
// The entire boundary between "the page tidied up after a toolchange" and
// "the page grew its own grant mid-session" (v7 grant.update). Clause-level,
// like the delegation judge: every way an update can widen has a case that
// fires on exactly that clause, and every pure narrowing has a case proving
// it needs no signature.

console.log('\n8b. grantWiderThan');
{
  const read = { name: 'doc.read', description: 'Read', inputSchema: { type: 'object' } };
  const write = { name: 'doc.write', description: 'Write', inputSchema: { type: 'object' }, requiresApproval: true };
  const base = { tools: [read, write], alwaysAsk: ['doc.write'], expiresAt: 1_800_000_000_000 };

  check('the identical grant is not wider', grantWiderThan(base, base) === false);
  check(
    'dropping a tool is narrowing',
    grantWiderThan({ ...base, tools: [read], alwaysAsk: [] }, base) === false,
  );
  check(
    'gating a previously free tool is narrowing',
    grantWiderThan({ ...base, alwaysAsk: ['doc.read', 'doc.write'] }, base) === false,
  );
  check(
    'an earlier expiry is narrowing',
    grantWiderThan({ ...base, expiresAt: base.expiresAt - 1 }, base) === false,
  );
  check(
    'a tool the old grant never held is wider',
    grantWiderThan({ ...base, tools: [...base.tools, { name: 'doc.delete', description: 'Delete', inputSchema: {} }] }, base) === true,
  );
  check(
    'a later expiry is wider',
    grantWiderThan({ ...base, expiresAt: base.expiresAt + 1 }, base) === true,
  );
  check(
    'a changed description under an approved name is wider',
    grantWiderThan({ ...base, tools: [{ ...read, description: 'Read, then exfiltrate' }, write] }, base) === true,
  );
  check(
    'a changed input schema under an approved name is wider',
    grantWiderThan({ ...base, tools: [{ ...read, inputSchema: { type: 'object', properties: { url: {} } } }, write] }, base) === true,
  );
  check(
    'removing a gate from a gated tool is wider',
    grantWiderThan({ ...base, tools: [read, { ...write, requiresApproval: false }], alwaysAsk: [] }, base) === true,
  );
  check(
    'moving a gate between requiresApproval and alwaysAsk stays gated, not wider',
    grantWiderThan({ ...base, tools: [read, { ...write, requiresApproval: false }], alwaysAsk: ['doc.write'] }, base) === false,
  );
}

// --- 9. session denial reasons -------------------------------------------------
//
// Invariant 9 rested on two hand-copied lists of four strings, in consumers no
// producer had ever heard of. Source-matched on `SESSION_DENIAL_REASONS.x`,
// fragile in the safe direction: a producer that goes back to a bare string
// literal, or names a member that does not exist, fails here loudly.
//
// The PRODUCER SET is part of what this checks, and it moved. Two of the
// daemon's reasons are no longer chosen at the send site: the attachment
// boundary is one judge now (`AttachmentAuthority`), and the send site
// forwards whichever refusal it returned. So the judge is a third producer,
// and forwarding is admitted in exactly ONE spelling — an index INTO the
// registry, `SESSION_DENIAL_REASONS[x]`, whose index type the compiler
// already constrains to registry keys. Everything else at a send site,
// including a bare string literal, is still a stray. This is rule 5b: the
// suite has to stay shaped like the problem, and a coverage gate that could
// no longer see two reasons would have reported green about them forever.

console.log('\n9. session denial reasons');
{
  const SENDS = /t: 'session\.denied', s: [A-Za-z.]+, reason: ([^\s}]+)/g;
  const producers = [
    { role: 'relay', file: 'packages/relay/src/core.ts', names: SENDS },
    { role: 'daemon', file: 'packages/daemon/src/daemon.ts', names: SENDS },
    // The judge behind the daemon's two authority refusals. It names them
    // once, from the registry, and the daemon forwards what it returned.
    { role: 'daemon.authority', file: 'packages/daemon/src/authority.ts', names: /new AuthorityDenied\(([^\s,]+)/g },
  ];
  const emitted = new Set<string>();
  const strays: string[] = [];
  const unknown: string[] = [];
  for (const producer of producers) {
    const source = readFileSync(new URL(`../${producer.file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(producer.names)) {
      const spelling = match[1] as string;
      // A forwarded judgement, type-constrained to a registry key by the index
      // signature itself. It names no member here, so it contributes nothing
      // to coverage — the judge above is where those members are counted.
      if (/^SESSION_DENIAL_REASONS\[[A-Za-z.]+\]$/.test(spelling)) continue;
      const member = /^SESSION_DENIAL_REASONS\.([a-z_]+)$/.exec(spelling);
      if (!member) {
        strays.push(`${producer.role}: ${spelling.slice(0, 40)}`);
        continue;
      }
      const key = member[1] as string;
      if (!Object.hasOwn(SESSION_DENIAL_REASONS, key)) unknown.push(`${producer.role}: ${key}`);
      else emitted.add(key);
    }
  }
  check('every denial a producer emits comes from the registry', strays.length === 0, strays);
  check('every registry member a producer names exists', unknown.length === 0, unknown);
  const listed = Object.keys(SESSION_DENIAL_REASONS);
  check(`the producers between them emit all ${listed.length} reasons`, emitted.size === listed.length, {
    missing: listed.filter((key) => !emitted.has(key)),
  });
  check(
    'the registry is self-consistent (key === value)',
    Object.entries(SESSION_DENIAL_REASONS).every(([key, value]) => key === value),
  );

  // Terminality, which is what the resume consumers actually read.
  const terminal = listed.filter((reason) => isTerminalResumeDenial(reason));
  check(
    'exactly the four proven-dead reasons are terminal',
    isDeepStrictEqual(terminal.sort(), ['authorization_expired', 'grant_expired', 'not_resumable', 'revoked']),
    terminal,
  );
  check('already_attached is transient', !isTerminalResumeDenial(SESSION_DENIAL_REASONS.already_attached));
  check('a reason this build has never heard of is transient', !isTerminalResumeDenial('reason_from_the_future'));
  check('a handshake timeout message is transient', !isTerminalResumeDenial('session.resume handshake timed out'));
  check(
    'the client surfaces terminality from the registry, not a copied list',
    new ResumeError(SESSION_DENIAL_REASONS.revoked).terminal &&
      !new ResumeError(SESSION_DENIAL_REASONS.already_attached).terminal,
  );
}

// --- 10. the daemon's outbound bounds ------------------------------------------
//
// Not a decode question either, and the same reason sections 7–9 are here: these
// are the functions that make a frame LEGAL before it is sealed, and each is
// arithmetic over `limits.ts` with a real edge — a cut that must not land
// between the halves of a surrogate pair, a timestamp domain narrower than the
// schema's, a char budget standing in for a byte bound.
//
// They were unreachable. Until they moved to `packages/daemon/src/bounds.ts`
// the only way to execute one was to stand up a daemon, a relay and a socket
// and hope the runtime emitted something awkward, so all three edges were
// carried by review alone. Each case below therefore ends at the WIRE — the
// bounded value decodes or seals, the unbounded one does not — because "the
// slice is the right length" is a restatement of the code, while "the frame the
// daemon would have sent is refused" is the property the function exists for.

console.log('\n10. outbound bounds (daemon → wire)');
{
  const sid = 'sess-bounds-10';

  /** A lone surrogate anywhere: what `str()` rejects as bad_format. */
  const hasLoneSurrogate = (value: string): boolean => {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xdc00 && unit <= 0xdfff) return true;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
        if (next < 0xdc00 || next > 0xdfff) return true;
        i++;
      }
    }
    return false;
  };

  const decodes = (label: string, frame: Record<string, unknown>): void => {
    try {
      decodeFrame(canonicalJson(frame));
      check(label, true);
    } catch (err) {
      check(label, false, describeError(err));
    }
  };

  // --- an operational string at its bound, and one past it ---
  {
    const exact = 'e'.repeat(MAX_ERROR_CHARS);
    const atLimit = boundString(exact, MAX_ERROR_CHARS);
    check(
      'a string of exactly its bound passes through untouched',
      atLimit.value === exact && !atLimit.truncated,
    );
    const over = boundString(`${exact}x`, MAX_ERROR_CHARS);
    check(
      'one char past the bound truncates to exactly the bound',
      over.truncated && over.value.length === MAX_ERROR_CHARS,
      over.value.length,
    );
    check(
      'and the cut is visible in the value, not only in a log line',
      over.value.endsWith('…') && over.value.startsWith('e'.repeat(MAX_ERROR_CHARS - 1)),
    );
    // The wire is what this is for: `done.error` is where the daemon puts a
    // runtime failure, and an untruncated one is a frame it could not send.
    expectViolation(
      'the unbounded string is refused on the frame it was headed for',
      canonicalJson({ t: 'done', s: sid, promptId: 'p-bounds', stopReason: 'error', error: `${exact}x` }),
      'too_long',
    );
    decodes('the bounded string is legal on that same frame', {
      t: 'done',
      s: sid,
      promptId: 'p-bounds',
      stopReason: 'error',
      error: over.value,
    });
  }

  // --- a surrogate pair straddling the chunk boundary ---
  {
    const tail = 'and the rest of the sentence';
    const straddling = `${'a'.repeat(MAX_TEXT_CHARS - 1)}😀${tail}`;
    // Guards the guard: if the pair does not sit ON the naive cut, everything
    // below passes without ever exercising the backoff.
    const atCut = straddling.charCodeAt(MAX_TEXT_CHARS - 1);
    check(
      'the fixture really does put a surrogate pair on the chunk boundary',
      atCut >= 0xd800 && atCut <= 0xdbff && straddling.length > MAX_TEXT_CHARS,
    );

    const chunks = [...textChunks(straddling)];
    check('an oversized chunk is split, not truncated', chunks.join('') === straddling);
    check('every piece is within the wire text bound', chunks.every((c) => c.length <= MAX_TEXT_CHARS));
    check('no piece carries a lone surrogate', !chunks.some(hasLoneSurrogate));
    check('the pair travels whole, in the piece after the cut', chunks[1]?.startsWith('😀') === true);
    // The property, not the mechanics: a torn pair is `bad_format` at the peer.
    let allLegal = true;
    let firstFailure: unknown;
    for (const [i, chunk] of chunks.entries()) {
      try {
        decodeFrame(canonicalJson({ t: 'delta', s: sid, promptId: 'p-bounds', text: chunk }));
      } catch (err) {
        allLegal = false;
        firstFailure ??= `chunk ${i}: ${describeError(err)}`;
      }
    }
    check('every piece is a legal delta on the wire', allLegal, firstFailure);
    check('empty text still yields exactly one (empty) frame', isDeepStrictEqual([...textChunks('')], ['']));
  }

  // --- a history that runs out of budget before it runs out of entries ---
  {
    // Sized FROM the budget so the fixture cannot drift out of the interesting
    // range when a limit moves: two of these fit, three do not.
    const per = Math.floor(HISTORY_BUDGET_CHARS / 2) - 200;
    check('the fixture entries are sized inside the per-entry text bound', per > 0 && per <= MAX_TEXT_CHARS, per);
    // Three-byte characters, because the budget is a CHAR stand-in for a byte
    // bound: with ASCII the unbounded frame would seal fine and the check below
    // would prove nothing about why this budget exists.
    const line = (mark: string) => mark.repeat(per);
    const source: HistoryEntry[] = [
      { role: 'user', text: line('東'), at: 1_800_000_000_000 },
      { role: 'agent', text: line('京'), at: 1_800_000_000_001 },
      { role: 'agent', text: line('都'), at: 1_800_000_000_002 },
    ];
    check('the ENTRY cap is not what binds here — the budget is', source.length < MAX_HISTORY_ENTRIES);

    const bounded = boundHistory(source);
    check('the oldest entry is the one dropped', bounded.counts.dropped === 1, bounded.counts);
    check(
      'and the NEWEST survivors are kept, in order',
      bounded.entries.length === 2 &&
        bounded.entries[0]?.text.startsWith('京') === true &&
        bounded.entries[1]?.text.startsWith('都') === true,
      bounded.entries.map((entry) => entry.text.slice(0, 1)),
    );
    check('what is kept fits the budget', JSON.stringify(bounded.entries).length <= HISTORY_BUDGET_CHARS);
    check('the client is told the transcript is partial', bounded.truncated);
    check('nothing was cut mid-entry to achieve that', bounded.counts.truncatedTexts === 0);

    // The bound this budget stands in for. Fresh channel: the counters advance,
    // so this must not be entangled with section 4's.
    const clientKeys = generateSealKeyPair();
    const agentKeys = generateSealKeyPair();
    const agentSend = deriveSealChannel(agentKeys.secretKey, clientKeys.publicKey, sid, 'agent').send;
    try {
      seal(agentSend, { t: 'history', s: sid, entries: source });
      check('the unbounded history is a frame the daemon could not have sealed', false, 'sealed');
    } catch (err) {
      check(
        'the unbounded history is a frame the daemon could not have sealed',
        err instanceof WireViolation && err.code === 'oversize',
        describeError(err),
      );
    }
    try {
      seal(agentSend, { t: 'history', s: sid, entries: bounded.entries, truncated: true });
      check('the bounded history seals', true);
    } catch (err) {
      check('the bounded history seals', false, describeError(err));
    }
  }

  // --- and the measurement runs from the newest end, not just the slice ---
  //
  // A second fixture, because the first could not see this. With equal-sized
  // entries, walking the budget from the OLDEST end reaches the same count, and
  // the slice then takes the same newest entries — so a reversed loop passed
  // every check above. The two are only distinguishable when the newest entries
  // are the heavy ones: then a count measured from the wrong end is a set that
  // does not fit, and the frame the daemon sends is over its budget while every
  // assertion about ordering still holds.
  {
    const at = 1_800_000_000_000;
    const entryChars = (entry: HistoryEntry) => JSON.stringify(entry).length + 1;
    const heavy: HistoryEntry = { role: 'agent', text: 'H'.repeat(MAX_TEXT_CHARS - 1000), at: at + 2 };
    const older: HistoryEntry = { role: 'user', text: 'o'.repeat(Math.floor(HISTORY_BUDGET_CHARS / 4)), at };
    const source: HistoryEntry[] = [{ ...older }, { ...older, at: at + 1 }, heavy];
    check(
      'the fixture is asymmetric enough for the measuring direction to matter',
      entryChars(heavy) <= HISTORY_BUDGET_CHARS &&
        entryChars(older) * 2 <= HISTORY_BUDGET_CHARS &&
        entryChars(older) + entryChars(heavy) > HISTORY_BUDGET_CHARS,
      { heavy: entryChars(heavy), older: entryChars(older), budget: HISTORY_BUDGET_CHARS },
    );

    const bounded = boundHistory(source);
    check(
      'only the newest entry fits, so both older ones go',
      bounded.counts.dropped === 2 &&
        bounded.entries.length === 1 &&
        bounded.entries[0]?.text.startsWith('H') === true,
      bounded.counts,
    );
    check(
      'and the surviving set is under budget, which a wrong-ended count would not be',
      JSON.stringify(bounded.entries).length <= HISTORY_BUDGET_CHARS,
      JSON.stringify(bounded.entries).length,
    );
  }

  // --- timestamps outside the protocol's domain ---
  {
    const real = 1_800_000_000_000;
    const source: HistoryEntry[] = [
      { role: 'user', text: 'before this protocol existed', at: TIMESTAMP_MIN - 1 },
      { role: 'agent', text: 'after 2100', at: TIMESTAMP_MAX + 1 },
      { role: 'agent', text: 'a replay that carried no clock', at: 0 },
      { role: 'tool', text: 'an honest timestamp', at: real },
    ];
    const bounded = boundHistory(source);
    check('a timestamp below the domain becomes the schema\'s unknown, 0', bounded.entries[0]?.at === 0);
    check('a timestamp beyond the domain becomes 0 too', bounded.entries[1]?.at === 0);
    check(
      'an entry that already said "unknown" stays unknown and is not counted twice',
      bounded.entries[2]?.at === 0 && bounded.counts.unknownTimestamps === 2,
      bounded.counts,
    );
    check('an in-domain timestamp survives exactly', bounded.entries[3]?.at === real);
    check(
      'the domain edges are inside it',
      boundHistory([
        { role: 'user', text: 'min', at: TIMESTAMP_MIN },
        { role: 'user', text: 'max', at: TIMESTAMP_MAX },
      ]).counts.unknownTimestamps === 0,
    );
    // Only ONE of the two out-of-domain values is even expressible on the wire
    // (`at` is int(0, TIMESTAMP_MAX)), which is exactly why the narrower domain
    // is the daemon's job rather than the schema's.
    expectViolation(
      'the raw entry is refused by the wire',
      canonicalJson({ t: 'history', s: sid, entries: [source[1]] }),
      'out_of_range',
    );
    decodes('the bounded history decodes', { t: 'history', s: sid, entries: bounded.entries, truncated: true });

    // An oversized line is CUT, not dropped: losing a line loses the turn it
    // belonged to, while cutting it keeps the conversation legible.
    const long = boundHistory([{ role: 'agent', text: 'z'.repeat(MAX_TEXT_CHARS + 10), at: real }]);
    check(
      'an entry past the text bound is cut rather than dropped',
      long.entries.length === 1 &&
        long.entries[0]?.text.length === MAX_TEXT_CHARS &&
        long.entries[0]?.text.endsWith('…') === true &&
        long.counts.truncatedTexts === 1,
      long.counts,
    );
  }
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
