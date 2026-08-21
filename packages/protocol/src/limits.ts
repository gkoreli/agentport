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

/**
 * Standard base64 (RFC 4648, with padding), the encoding ACP itself carries
 * image payloads in — so a prompt block crosses to the runtime byte-for-byte
 * with no re-encoding step to get wrong. Length-mod-4 is enforced by the
 * Prompt refinement, not the pattern: a regex cannot count.
 */
export const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Image blocks on one prompt (v7, upload direction only).
 *
 * The numbers are one budget, reasoned together, because all three live
 * inside MAX_SEALED_PLAINTEXT_BYTES (491,520) with the frame's own framing:
 *
 * - MAX_PROMPT_IMAGE_CHARS bounds the AGGREGATE base64 across every block on
 *   one prompt: 393,216 chars is 288 KiB of binary image, and base64 is
 *   ASCII so chars are bytes on the wire.
 * - MAX_PROMPT_TEXT_WITH_BLOCKS_CHARS caps the TEXT of a prompt that carries
 *   blocks. Text may be CJK (3 UTF-8 bytes per UTF-16 unit), so 16,384 units
 *   is at most 49 KiB — caption scale, which is what text beside an image is.
 *   393,216 + 49,152 + framing < 460,000, comfortably under the seal bound;
 *   a text-only prompt keeps the full MAX_TEXT_CHARS it always had.
 * - MAX_PROMPT_BLOCKS caps the count: four is what a composer can honestly
 *   preview as attachments; more is a gallery, and a gallery is a tool's job.
 */
export const MAX_PROMPT_BLOCKS = 4;
export const MAX_PROMPT_IMAGE_CHARS = 393_216;
export const MAX_PROMPT_TEXT_WITH_BLOCKS_CHARS = 16_384;

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

/**
 * Steps in one plan snapshot. A plan is a checklist a person reads while the
 * agent works, so the bound is set by what a panel can honestly render rather
 * than by what a runtime might emit: past a few dozen steps the list stops
 * being a progress indicator. Each snapshot replaces the last, so this caps
 * one frame, not the plan's lifetime.
 */
export const MAX_PLAN_STEPS = 64;

/**
 * One plan step's text. Steps are short imperative lines ("Read the draft"),
 * not prose; the same cap as a tool description leaves room for a wordy
 * runtime without letting a step become a transcript.
 */
export const MAX_PLAN_STEP_CHARS = MAX_DESCRIPTION_CHARS;

/**
 * How long a SessionDelegation may live, from `issuedAt` to `expiresAt`
 * (ADR-022 R3). Two jobs, both load-bearing.
 *
 * It bounds the blast radius of a stolen delegation — an approval must not be
 * able to outlive the browser session that made it, and nothing else stops a
 * wallet signing one that expires in a decade.
 *
 * And it is what makes the daemon's revocation store bounded *by
 * construction*: a per-origin tombstone can be dropped once
 * `revokedAt + MAX_DELEGATION_LIFETIME_MS` is past, because after that no
 * delegation issued before the revocation can still be live. No cap, no
 * eviction policy, no decision about what to do when the store fills.
 *
 * 24h leaves room above the 8h the hosted wallet issues today without making
 * the tombstone window long enough to matter.
 */
export const MAX_DELEGATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * How far into the FUTURE a delegation's `issuedAt` may sit before a judge
 * refuses it (`delegation.ts` → `not_yet_valid`).
 *
 * Three parties judge a delegation on three machines — the page that received
 * it, the relay that routes it, the daemon that honours it — and none of them
 * shares a clock. A consumer browser a couple of minutes out of step is
 * ordinary, and refusing an honest approval over it would be a worse failure
 * than the one this bound exists to stop.
 *
 * Past that, a future `issuedAt` is not skew, it is an escape. Revocation is a
 * tombstone (`packages/daemon/src/revocations.ts#isRevoked`) that refuses delegations
 * issued at or before the moment of revocation, so a delegation dated forward
 * survives every tombstone recorded before its date — and because
 * MAX_DELEGATION_LIFETIME_MS is measured from `issuedAt`, post-dating slides
 * the whole live window forward with it. Without this bound a wallet holding
 * the user key (the in-page demo tier) could mint an authority that is both
 * effectively permanent and unrevocable, and every judge would have called it
 * well-formed.
 *
 * Five minutes is the same order as Kerberos' default clock skew and the
 * leeway conventionally allowed on a JWT `nbf`: wide enough for unsynchronised
 * consumer clocks, narrow enough that "revoke, then wait five minutes" is a
 * complete answer rather than an open question.
 */
export const MAX_DELEGATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Fields in one elicitation form, and options in one choice field (ADR-024).
 *
 * Bounded by US, not by the asker. A real `AskUserQuestion` is already capped
 * by the agent SDK at 4 questions of at most 4 options — but an MCP server's
 * elicitation passes the server's own JSON Schema through with only
 * `type: "object"` forced, which is arbitrary and unbounded. These are the
 * numbers a human can actually read in one sitting: a form too large to read
 * is not a consent surface, and the honest answer to one is to refuse it
 * rather than render a wall.
 */
export const MAX_FORM_FIELDS = 12;
export const MAX_FORM_OPTIONS = 16;

/**
 * One field's label, and one option's label. A form is rendered in a dialog,
 * not a document; the same ceiling as a tool description is already generous
 * for a question, and far past it the field is not a question any more.
 */
export const MAX_FORM_LABEL_CHARS = MAX_DESCRIPTION_CHARS;

/**
 * A free-text answer. Deliberately far below MAX_TEXT_CHARS: this is a line a
 * person typed into a box, not a document, and the value crosses into the
 * agent's reasoning carrying the user's authority — the one place where
 * generosity about size is generosity to whoever is lying.
 */
export const MAX_ANSWER_CHARS = 4096;

/**
 * Ceiling on the closed-session count a `revoked` ack reports. The number is
 * feedback for the user ("ended 2 attachments"), never an authority, so the
 * daemon clamps rather than failing — but an unbounded integer on the wire is
 * a schema hole regardless of what the value means.
 */
export const MAX_SESSIONS_REPORTED = 4096;

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
