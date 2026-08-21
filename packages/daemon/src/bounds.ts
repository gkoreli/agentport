/**
 * What the daemon may put on the wire, as arithmetic over `limits.ts`.
 *
 * The other passenger inside `daemon.ts`: three functions that share nothing
 * with the session aggregate — no socket, no clock, no state — and whose edges
 * are the interesting part. A truncation that lands between the halves of a
 * surrogate pair produces text the schema rejects; a timestamp outside the
 * protocol's domain has to become the schema's explicit "unknown" rather than
 * be invented from our own clock; a history frame has to fit under the SEALED
 * plaintext bound, which is a different and much tighter number than the entry
 * cap that used to be mistaken for it.
 *
 * They lived where nothing could reach them without standing up a daemon and a
 * socket, so `scripts/wire-check.ts` §10 calls them directly. Pure by
 * construction for exactly that reason: LOGGING stays at the daemon's call
 * sites, which is why each of these reports what it did instead of writing it
 * down — a function that logged would need a session id, and a session id is
 * the one thing this file must not know about.
 */

import {
  MAX_HISTORY_ENTRIES,
  MAX_SEALED_PLAINTEXT_BYTES,
  MAX_TEXT_CHARS,
  TIMESTAMP_MAX,
  TIMESTAMP_MIN,
  type HistoryEntry,
} from '@agentport/protocol';

/**
 * Char budget for one history frame's entries. UTF-8 never exceeds 3 bytes
 * per UTF-16 code unit, so a char budget of bytes/3 cannot overflow the
 * sealed-plaintext byte bound however the text encodes; the subtraction
 * covers the frame envelope around the entries array.
 */
export const HISTORY_BUDGET_CHARS = Math.floor(MAX_SEALED_PLAINTEXT_BYTES / 3) - 1024;

/** A string cut to fit, and whether cutting happened. */
export interface BoundedString {
  value: string;
  truncated: boolean;
}

/**
 * Fits an operational string (error detail, close reason) to its wire bound.
 *
 * Exactly `max` is legal and passes through untouched; one char past it comes
 * back at exactly `max` chars, the last of which says so. The caller logs the
 * cut — only the LENGTHS are log material, since a runtime error message can
 * embed tool output, which is hostile data.
 */
export function boundString(value: string, max: number): BoundedString {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max - 1)}…`, truncated: true };
}

/**
 * Splits conversation text into frame-sized pieces.
 *
 * Content is never truncated silently — a runtime chunk larger than the wire's
 * text bound is split across frames instead — and empty text still yields one
 * (empty) piece, which is what makes an empty delta a frame rather than
 * nothing at all.
 *
 * Never cuts between a surrogate pair: the halves are not well-formed Unicode
 * and the wire schema rejects them, so a boundary landing inside a pair backs
 * off one code unit and the pair travels whole in the next piece. (A piece of
 * exactly one high surrogate cannot happen: MAX_TEXT_CHARS is far larger than
 * 1, so the backed-off piece is never empty.)
 */
export function* textChunks(text: string): Generator<string> {
  let offset = 0;
  do {
    let end = Math.min(offset + MAX_TEXT_CHARS, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    yield text.slice(offset, end);
    offset = end;
  } while (offset < text.length);
}

/** A history replay cut to fit one frame, and what had to be done to it. */
export interface BoundedHistory {
  entries: HistoryEntry[];
  /**
   * The client is seeing a PARTIAL transcript — some entry was cut short, or
   * some entry did not fit at all. Deliberately not set by an out-of-domain
   * timestamp: the conversation is all there, only its clock was not.
   */
  truncated: boolean;
  /** Counts for the caller's log line. Never the text itself. */
  counts: {
    entries: number;
    dropped: number;
    truncatedTexts: number;
    unknownTimestamps: number;
  };
}

/**
 * Bounds a history replay for one frame.
 *
 * History is a replay, not the source of truth — the runtime's own store keeps
 * the full text — so the wire copy is bounded: NEWEST entries kept, up to the
 * schema's entry cap and a conservative sealed-plaintext budget, oversized
 * lines truncated. Timestamps outside the protocol domain become 0 — the
 * schema's explicit "unknown" (ACP replay has no timestamps) — and are never
 * fabricated from our own clock.
 *
 * The budget, not the entry cap, is what usually binds: `MAX_HISTORY_ENTRIES`
 * is 4096 and two maximal entries already exceed `HISTORY_BUDGET_CHARS`.
 */
export function boundHistory(source: readonly HistoryEntry[]): BoundedHistory {
  let truncatedTexts = 0;
  let unknownTimestamps = 0;
  const bounded = source.map((entry): HistoryEntry => {
    const cut = entry.text.length > MAX_TEXT_CHARS;
    if (cut) truncatedTexts++;
    const inDomain = entry.at >= TIMESTAMP_MIN && entry.at <= TIMESTAMP_MAX;
    if (!inDomain && entry.at !== 0) unknownTimestamps++;
    return {
      role: entry.role,
      text: cut ? `${entry.text.slice(0, MAX_TEXT_CHARS - 1)}…` : entry.text,
      at: inDomain ? entry.at : 0,
    };
  });
  let used = 0;
  let keep = 0;
  for (let i = bounded.length - 1; i >= 0 && keep < MAX_HISTORY_ENTRIES; i--) {
    used += JSON.stringify(bounded[i]!).length + 1;
    if (used > HISTORY_BUDGET_CHARS) break;
    keep++;
  }
  const dropped = bounded.length - keep;
  return {
    entries: bounded.slice(bounded.length - keep),
    truncated: truncatedTexts > 0 || dropped > 0,
    counts: { entries: bounded.length, dropped, truncatedTexts, unknownTimestamps },
  };
}
