import { FRAME_SCHEMAS, type Frame, type FrameType } from './messages.js';
import { MAX_FRAME_CHARS, MAX_RAW_DEPTH } from './limits.js';
import { WireViolation } from './schema.js';
import { canonicalJson } from './crypto.js';

/**
 * The one wire encoding: canonicalJson — sorted keys, no whitespace, minimal
 * escapes. Sorted matters: it makes the encoding of a value UNIQUE, which is
 * what lets decodeFrame reject every other spelling of the same frame
 * (ADR-019 §1 "reject duplicate or ambiguous representations"). Signatures
 * already canonicalize this way; the wire now matches.
 */
export function encodeFrame(frame: Frame): string {
  const wire = canonicalJson(frame);
  // The one place a frame becomes bytes, so the one place the frame bound can
  // be guaranteed rather than hoped for: individually-legal fields can still
  // add up past the cap, and a peer must never receive a frame it is obliged
  // to reject. The string already exists, so this costs a length compare.
  if (wire.length > MAX_FRAME_CHARS) throw new WireViolation('oversize', frame.t);
  return wire;
}

/**
 * Raw nesting scan, before JSON.parse and canonicalJson ever run: both
 * recurse, and V8's stringify overflows the stack near ~5k depth — a
 * pre-validation DoS if unchecked. One linear pass, string-aware.
 */
function rawDepthWithin(data: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c /* \ */) i++;
      else if (ch === 0x22 /* " */) inString = false;
    } else if (ch === 0x22) inString = true;
    else if (ch === 0x7b /* { */ || ch === 0x5b /* [ */) {
      if (++depth > max) return false;
    } else if (ch === 0x7d /* } */ || ch === 0x5d /* ] */) {
      // A closer with nothing open means malformed input; stop rather than
      // let the counter go negative and buy headroom for later nesting.
      if (depth === 0) return false;
      depth--;
    }
  }
  return true;
}

/**
 * The wire boundary (ADR-019 Gate B §1). Returns a typed frame only after
 * full strict validation; throws WireViolation otherwise, carrying a stable
 * code and a schema-derived path — never bytes from the input.
 *
 * The canonical-form check (step 4) is the duplicate-key and ambiguity
 * defense: the wire form MUST be byte-exact canonicalJson of the value it
 * encodes — one valid encoding per frame. Duplicate keys, whitespace,
 * key-order variance, `\/`-style escapes, `1e3`, `-0` all fail. Every
 * emitter in the system goes through encodeFrame (the relay re-encodes
 * after stamping), so canonical form survives every hop; a third-party
 * implementation must emit the same canonical bytes — a documented wire
 * requirement, not an implementation leak.
 */
export function decodeFrame(data: string): Frame {
  if (data.length > MAX_FRAME_CHARS) throw new WireViolation('oversize', '');
  if (!rawDepthWithin(data, MAX_RAW_DEPTH)) throw new WireViolation('too_deep', '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new WireViolation('bad_json', '');
  }
  if (canonicalJson(parsed) !== data) throw new WireViolation('non_canonical', '');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WireViolation('wrong_type', '');
  }
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(FRAME_SCHEMAS, t)) {
    throw new WireViolation('unknown_type', '');
  }
  return FRAME_SCHEMAS[t as FrameType](parsed, t);
}

/** Minimal promise handle used by the request/response paths. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

type Listener<T> = (value: T) => void;

/** Tiny typed event emitter; avoids a Node dependency in browser code. */
export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set!.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as Listener<Events[K]>)(value);
  }
}
