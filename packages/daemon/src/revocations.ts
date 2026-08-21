import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_DELEGATION_LIFETIME_MS, randomId } from '@agentport/protocol';

/**
 * "This website may no longer use my agent" (ADR-022).
 *
 * A revocation is a tombstone, not a denylist: `{origin, at}` refuses every
 * authority that origin holds which began at or before `at`, and admits one
 * that began after it. So withdrawing authority is complete and re-approving
 * needs no un-revoke verb — the user simply approves again, and the new
 * authority carries a later instant.
 *
 * "Authority" and not "delegation": the object being addressed is the ORIGIN,
 * across tiers. A delegated attachment's authority began when the wallet
 * signed it (`issuedAt`); a direct-key attachment's — the extension, which
 * holds the user key and needs no delegation — began when the session opened.
 * Judging only the first is what left the extension tier outside revocation
 * entirely (ADR-022 addendum, and `RevocableAuthority` below).
 *
 * That shape is also what keeps the store finite without a cap or an eviction
 * policy. A delegation's lifetime is bounded (MAX_DELEGATION_LIFETIME_MS), so
 * once `at + MAX_DELEGATION_LIFETIME_MS` is past, no delegation the tombstone
 * could still refuse is alive, and the entry is dropped on the next write.
 */
export interface Revocation {
  origin: string;
  /** Unix ms. Delegations issued at or before this are refused. */
  at: number;
}

export function revocationsPath(identityPath: string): string {
  return process.env.AGENTPORT_REVOCATIONS_FILE ?? join(dirname(identityPath), 'revocations.json');
}

/** Entries that can no longer refuse anything are not worth keeping. */
export function pruneRevocations(revocations: Revocation[], now: number): Revocation[] {
  return revocations.filter((entry) => entry.at + MAX_DELEGATION_LIFETIME_MS > now);
}

/**
 * Atomic, and deliberately NOT part of the identity file: `saveIdentity` is a
 * bare write, so folding revocations into it would put the device secret key
 * one crashed write away from being lost.
 */
export function saveRevocations(path: string, revocations: Revocation[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomId('tmp_')}`;
  writeFileSync(temporary, JSON.stringify(revocations), { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * A file that will not parse is treated as no revocations, and the caller is
 * told so it can log and continue. Refusing to start would turn a corrupt
 * file into an outage; pretending it parsed would silently restore authority
 * the user withdrew. Neither is acceptable silently, so it is surfaced.
 */
export function loadRevocations(path: string): { revocations: Revocation[]; error?: Error } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { revocations: [] };
    return { revocations: [], error: err as Error };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('revocations file is not an array');
    const revocations: Revocation[] = [];
    for (const entry of parsed) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Revocation).origin !== 'string' ||
        typeof (entry as Revocation).at !== 'number' ||
        !Number.isFinite((entry as Revocation).at)
      ) {
        throw new Error('malformed revocation entry');
      }
      revocations.push({ origin: (entry as Revocation).origin, at: (entry as Revocation).at });
    }
    return { revocations };
  } catch (err) {
    return { revocations: [], error: err as Error };
  }
}

/**
 * What a tombstone is judged against: whose origin, and when that authority
 * began.
 *
 * A SHAPE rather than `SessionDelegation`, because a delegation is not the
 * only authority a tombstone addresses. A `SessionDelegation` satisfies it
 * structurally, so the delegated tier keeps ADR-022's exact semantics; a
 * direct-key attachment — the extension, which holds the user key and
 * therefore carries no delegation — supplies its surface origin and the
 * instant the session opened. Widening the parameter rather than adding a
 * second predicate is what keeps this the ONE place the rule lives.
 */
export interface RevocableAuthority {
  origin: string;
  /** Unix ms. Authority that began at or before a tombstone's `at` is refused. */
  issuedAt: number;
}

/**
 * The one place the rule lives, so the open path, the resume path and the
 * daemon's live sweep cannot drift. Origin comparison is exact: an origin is
 * already a canonical scheme+host+port triple, and substring or suffix
 * matching would make `https://evil-inkwell.example` a match for
 * `inkwell.example`.
 */
export function isRevoked(revocations: readonly Revocation[], authority: RevocableAuthority): boolean {
  return revocations.some(
    (entry) => entry.origin === authority.origin && authority.issuedAt <= entry.at,
  );
}

/**
 * The daemon's view of revocation state. One port, two adapters: the daemon
 * never touches the filesystem itself, and an embedder (or a test) can hold
 * the set in memory without a temp directory.
 */
export interface RevocationStore {
  list(): readonly Revocation[];
  /** Records the tombstone and returns the pruned set now in force. */
  add(revocation: Revocation): readonly Revocation[];
}

export function memoryRevocations(initial: Revocation[] = []): RevocationStore {
  let entries = initial;
  return {
    list: () => entries,
    add(revocation) {
      entries = pruneRevocations([...entries, revocation], revocation.at);
      return entries;
    },
  };
}

/**
 * Durable revocations, at the edge that enforces them (ADR-016: the relay
 * holds none of this). A load failure is surfaced through `onError` rather
 * than thrown: refusing to start would turn a corrupt file into an outage,
 * and starting silently would restore authority the user withdrew.
 */
export function fileRevocations(path: string, onError: (err: Error) => void): RevocationStore {
  // Re-read on every list(), so the FILE is the source of truth rather than
  // this process's copy of it. That is what lets `agentport revoke` work
  // whether or not a daemon happens to be running: the CLI writes the
  // tombstone, and a live daemon enforces it on its very next judgement
  // without any request/response protocol between them. Cheap by
  // construction — the set is bounded (see above) and this runs only when a
  // session opens or resumes.
  const read = (): Revocation[] => {
    const loaded = loadRevocations(path);
    if (loaded.error) onError(loaded.error);
    return pruneRevocations(loaded.revocations, Date.now());
  };
  return {
    list: read,
    add(revocation) {
      const entries = pruneRevocations([...read(), revocation], revocation.at);
      saveRevocations(path, entries);
      return entries;
    },
  };
}
