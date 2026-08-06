/**
 * Wire-protocol bounds (ADR-019 Gate B §1–2).
 *
 * Every limit is a named constant with a rationale so a reviewer can judge it,
 * a test can probe its boundary, and an operator can reason about capacity.
 * Exceeding a limit fails the frame (or the session, for sealed traffic —
 * see seal.ts); it never degrades to a looser parse.
 */

/**
 * Upper bound on a wire frame in UTF-16 code units, checked before JSON.parse.
 * Chosen to match the Cloudflare Workers WebSocket message cap, which the
 * hosted relay already enforces — so the self-hosted Node relay is no more
 * permissive than the production one.
 *
 * The BYTE cap is enforced by the transports, and it is the binding one:
 * `maxPayload` on both Node WebSocket ends, the platform cap on Workers.
 * UTF-8 never uses fewer bytes than UTF-16 code units, so a byte cap of N
 * already implies at most N code units; this check is the in-process guard
 * for callers that did not arrive over a socket (sealed plaintext, tests).
 */
export const MAX_FRAME_CHARS = 1_048_576;

/**
 * Maximum raw bracket-nesting depth of a wire frame, scanned in one pass
 * BEFORE JSON.parse or any recursive re-serialization runs — both recurse,
 * and unbounded nesting is a stack-overflow DoS on the validator itself.
 * Frame structure needs ~8 levels; embedded JSON another MAX_JSON_DEPTH.
 * 32 leaves slack while staying far below engine stack limits.
 */
export const MAX_RAW_DEPTH = 32;

/**
 * Upper bound on a sealed frame's decrypted plaintext, in bytes, enforced
 * independently of the outer frame bound (ADR-019 §1). 480 KiB keeps the
 * worst-case `enc` envelope — 2 hex chars per ciphertext byte plus the
 * Poly1305 tag, nonce, and framing — under MAX_FRAME_CHARS with headroom.
 */
export const MAX_SEALED_PLAINTEXT_BYTES = 491_520;

/** Poly1305 tag, the fixed AEAD overhead on every ciphertext. */
export const AEAD_TAG_BYTES = 16;

/**
 * Ciphertext byte bound implied by the plaintext bound; validated on the
 * `enc` envelope so an oversized frame is rejected before any AEAD work.
 */
export const MAX_CIPHERTEXT_BYTES = MAX_SEALED_PLAINTEXT_BYTES + AEAD_TAG_BYTES;

/**
 * Opaque correlation handles: session ids, prompt/tool/approval ids, error
 * refs. The protocol does not dictate their internal shape (a third-party
 * wallet may mint its own), only a safe charset — no whitespace, no quotes,
 * nothing that needs escaping in logs — and a length that keeps them cheap
 * as Map keys. Generated ids today are prefix + 24 hex (≤ 29 chars).
 */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Pairing and connect codes, exactly as `pairingCode()` mints them —
 * including the I/O exclusion, so a code the minting alphabet cannot
 * produce is rejected rather than burning a claim attempt.
 */
export const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/**
 * Resume tokens are daemon-minted bearer secrets (48 hex today). The range
 * admits future longer tokens without admitting non-hex ones.
 */
export const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;

/**
 * Stable public error codes and reasons: lowercase snake case, never derived
 * from attacker input (ADR-019 §1 — no payload reflection).
 */
export const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * Timestamps are Unix milliseconds inside the protocol's operating domain.
 * Anything before the project existed or beyond 2100 is a bug or an attack,
 * not a schedulable expiry.
 */
export const TIMESTAMP_MIN = 1_577_836_800_000; // 2020-01-01T00:00:00Z
export const TIMESTAMP_MAX = 4_102_444_800_000; // 2100-01-01T00:00:00Z

/** Human-facing labels: agent/surface names, runtime, location. */
export const MAX_NAME_CHARS = 128;

/** Tool descriptions; matches the extension's long-standing cap. */
export const MAX_DESCRIPTION_CHARS = 4096;

/** Close/deny reasons and error messages: operational strings, not content. */
export const MAX_REASON_CHARS = 256;

/** Runtime error detail on `done`/`tool.result`. */
export const MAX_ERROR_CHARS = 1024;

/**
 * Browser origins are punycoded ASCII. A maximal DNS name (253 chars) plus
 * scheme and an explicit port serializes past 256, so the bound is 512 —
 * comfortably above anything a real `URL.origin` can produce.
 */
export const MAX_ORIGIN_CHARS = 512;

/** Optional route/resource scope on a surface descriptor. */
export const MAX_ROUTE_CHARS = 2048;

/**
 * Conversation text: prompts, deltas, thoughts, history lines. Matches the
 * extension's page-boundary cap so the wire admits nothing the UI would drop.
 */
export const MAX_TEXT_CHARS = 131_072;

/** Tool names are namespaced identifiers, e.g. "inkwell.document.replace". */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Tools per capability grant; matches the extension and hosted wallet caps. */
export const MAX_TOOLS_PER_GRANT = 64;

/**
 * Aggregate serialized size of one grant's tool definitions (ADR-019 §1 asks
 * for this explicitly, since 64 individually-legal tools could still add up).
 * 128 KiB is far above any real surface — the Inkwell demo's whole grant is
 * under 1 KiB — while keeping a grant an order of magnitude below the frame
 * ceiling, so lifecycle frames stay cheap to validate and to display.
 */
export const MAX_GRANT_CHARS = 131_072;

/**
 * Bounds for embedded arbitrary JSON (tool input schemas, call arguments,
 * results, surface/prompt context). Depth and node count guard the walker;
 * the aggregate size is already capped by the frame/plaintext bounds.
 */
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_NODES = 16_384;
export const MAX_JSON_LEAF_CHARS = MAX_TEXT_CHARS;

/**
 * History replay is chunk-bounded by the sealed-plaintext cap; the entry
 * count keeps a single frame's walk cheap. The daemon truncates oldest-first
 * to fit (see AgentDaemon history replay).
 */
export const MAX_HISTORY_ENTRIES = 4096;

/** Directory listing size; a wallet with more agents than this is malformed. */
export const MAX_AGENTS_LISTED = 256;

/** Missed-frame counter on resume: routing metadata, not a real count. */
export const MAX_MISSED_COUNT = 1_000_000;

/**
 * Malformed frames tolerated on one authenticated socket before the relay
 * disconnects it (ADR-019 §2, delivered here because the counter lives in
 * the same boundary). Legitimate peers produce zero.
 */
export const MAX_MALFORMED_FRAMES = 8;
