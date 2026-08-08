/**
 * Strict runtime validation core (ADR-019 Gate B §1).
 *
 * Hand-rolled rather than a schema library because this ships in
 * `@agentport/protocol` — inside connect.js, into third-party pages — where a
 * dependency's whole surface would ride along for the ~dozen combinators the
 * wire protocol needs. The frame schemas in messages.ts are the single source
 * of truth: the exported TypeScript types are inferred from them, so a
 * validator and its type cannot drift apart.
 *
 * Semantics, fixed on purpose:
 *  - No coercion, ever. A field is the required JSON type or the value fails.
 *  - Objects are exact: an unknown key rejects the frame. This is what makes
 *    `__proto__` / `constructor` smuggling structurally impossible — they are
 *    just unknown keys.
 *  - Validated objects are rebuilt onto fresh plain objects; a handler never
 *    touches the parsed input directly.
 *  - Failures throw `WireViolation` carrying a closed-set code and a path made
 *    only of schema-defined keys and array indices. Attacker-chosen bytes
 *    never appear in codes, paths, messages, or logs (ADR-019 §1).
 */

/**
 * The closed set of public violation codes, as VALUES so tests and tooling
 * enumerate exactly what the type permits — one source of truth, no list to
 * forget to update. Adding a code here is the only way to add one.
 */
export const VIOLATION_CODES = [
  'oversize',
  'bad_json',
  'non_canonical',
  'unknown_type',
  'wrong_type',
  'missing_key',
  'unexpected_key',
  'too_short',
  'too_long',
  'bad_format',
  'out_of_range',
  'too_deep',
  'too_many',
  /** A frame type the sender may not originate on this path or direction. */
  'forbidden',
  /** Inner and outer envelopes disagree (e.g. sealed frame session id). */
  'mismatch',
  /** A collection that must be duplicate-free (or subset-consistent) is not. */
  'duplicate',
] as const;

export type ViolationCode = (typeof VIOLATION_CODES)[number];

export class WireViolation extends Error {
  constructor(
    readonly code: ViolationCode,
    /** Dot path of schema-defined segments, e.g. "session.open.grant.tools[3].name". */
    readonly path: string,
  ) {
    super(path === '' ? code : `${code} at ${path}`);
    this.name = 'WireViolation';
  }
}

/** A validator: returns the typed value or throws WireViolation. */
export type Schema<T> = (value: unknown, path: string) => T;

export type Infer<S> = S extends Schema<infer T> ? T : never;

/**
 * A structural description of what a schema accepts, carried by the schema
 * itself, so the wire's compatibility can be DERIVED rather than remembered.
 *
 * `PROTOCOL_VERSION` is the only thing between "these two peers disagree" and
 * a confusing failure after auth, and three breaking changes landed before
 * anyone noticed it had not moved — the same hand-maintained-registry defect
 * this codebase has hit five times.
 *
 * It describes NESTED shape, not just top-level fields, and that is the whole
 * point. The change worst to miss is `grantHash`: it lives inside
 * `SessionDelegation` and it is SIGNED, so two peers agreeing on a version
 * while computing different canonical bytes surfaces as `bad_delegation` — an
 * authorisation error that sends the operator looking at keys and clocks. A
 * fingerprint reaching only top level would have been silent about exactly
 * that one, while looking like a guarantee.
 */
export type WireShape =
  | { k: 'lit'; v: string }
  | { k: 'en'; v: readonly string[] }
  | { k: 'bool' }
  | { k: 'int'; min: number; max: number }
  | { k: 'str'; min: number; max: number }
  | { k: 'display'; min: number; max: number }
  | { k: 'pattern'; re: string; max: number }
  | { k: 'hex'; min: number; max: number }
  | { k: 'hexRange'; min: number; max: number }
  | { k: 'arr'; max: number; of: WireShape }
  | { k: 'obj'; fields: { key: string; optional: boolean; of: WireShape }[] }
  | { k: 'json'; record: boolean; depth: number; nodes: number; leaf: number }
  | { k: 'refined'; of: WireShape };

const SHAPE = Symbol.for('agentport.wireShape');

/** Attach a shape to a schema without changing how it validates. */
function described<T>(shape: WireShape, schema: Schema<T>): Schema<T> {
  Object.defineProperty(schema, SHAPE, { value: shape, enumerable: false });
  return schema;
}

/**
 * Read a schema's shape. Throws rather than returning a placeholder: a
 * combinator that forgot to describe itself would otherwise yield a
 * fingerprint that stays stable across real changes — worse than none,
 * because it would look like a guarantee.
 */
export function wireShapeOf(schema: Schema<unknown>): WireShape {
  const shape = (schema as unknown as Record<symbol, WireShape | undefined>)[SHAPE];
  if (!shape) throw new Error('schema has no wire shape; a combinator is not described');
  return shape;
}

/** Marks an object field as optional; absent keys are fine, present ones validate. */
export interface Optional<T> {
  readonly optional: true;
  readonly schema: Schema<T>;
}

export function opt<T>(schema: Schema<T>): Optional<T> {
  return { optional: true, schema };
}

type Field<T> = Schema<T> | Optional<T>;
type Shape = Record<string, Field<unknown>>;

type RequiredKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Optional<unknown> ? never : K;
}[keyof S];
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Optional<unknown> ? K : never;
}[keyof S];
type FieldType<F> = F extends Optional<infer T> ? T : F extends Schema<infer T> ? T : never;
type Pretty<T> = { [K in keyof T]: T[K] } & {};

export type ObjOut<S extends Shape> = Pretty<
  { [K in RequiredKeys<S>]: FieldType<S[K]> } & { [K in OptionalKeys<S>]?: FieldType<S[K]> }
>;

export function lit<const V extends string>(expected: V): Schema<V> {
  return described({ k: 'lit', v: expected }, (value, path) => {
    if (value !== expected) throw new WireViolation('wrong_type', path);
    return expected;
  });
}

export function en<const V extends readonly string[]>(...values: V): Schema<V[number]> {
  const set = new Set<string>(values);
  return described({ k: 'en', v: values }, (value, path) => {
    if (typeof value !== 'string' || !set.has(value)) throw new WireViolation('bad_format', path);
    return value as V[number];
  });
}

export function bool(): Schema<boolean> {
  return described({ k: 'bool' }, (value, path) => {
    if (typeof value !== 'boolean') throw new WireViolation('wrong_type', path);
    return value;
  });
}

/** Safe integer within [min, max]. Nothing else — no floats, no strings. */
export function int(min: number, max: number): Schema<number> {
  return described({ k: 'int', min, max }, (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new WireViolation('wrong_type', path);
    }
    // -0 is a safe integer that canonicalizes to "0": accepting it would mean
    // the value we validated is not the value that round-trips.
    if (Object.is(value, -0)) throw new WireViolation('wrong_type', path);
    if (value < min || value > max) throw new WireViolation('out_of_range', path);
    return value;
  });
}

/**
 * Unpaired surrogates are rejected everywhere a free-form string is accepted:
 * they survive a JS round-trip (JSON.stringify re-escapes them) but are not
 * valid Unicode, so a non-JS peer would decode the "same" frame differently —
 * exactly the ambiguity ADR-019 §1 forbids. RFC 8785 rejects them for the
 * same reason.
 */
function wellFormed(value: string, path: string): string {
  if (!value.isWellFormed()) throw new WireViolation('bad_format', path);
  return value;
}

/** String with length in [min, max] UTF-16 code units; must be well-formed Unicode. */
export function str(min: number, max: number): Schema<string> {
  return described({ k: 'str', min, max }, (value, path) => {
    if (typeof value !== 'string') throw new WireViolation('wrong_type', path);
    if (value.length < min) throw new WireViolation('too_short', path);
    if (value.length > max) throw new WireViolation('too_long', path);
    return wellFormed(value, path);
  });
}

/**
 * C0 controls, DEL, and C1. Never typed on purpose, and the set that lets a
 * string rewrite a surface instead of appearing on it.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A string a human will READ IN ORDER TO DECIDE something — a tool
 * description on a consent screen, a surface name, an approval summary, the
 * label on a question.
 *
 * Separate from `str` because the threat is separate. A site authors the tool
 * descriptions in its own grant, and the daemon prints them to the owner's
 * terminal at the connect-tier consent moment. `str` bounds length and rejects
 * unpaired surrogates; it says nothing about control characters, so
 * `ESC[2J ESC[H` in a description survived the decoder intact and reached
 * `console.log`. That clears the screen and homes the cursor: the site can
 * erase what the daemon just printed and draw its own consent screen in its
 * place — including a forged `verify:` line, which is the drop-in tier's only
 * defence against a relay in the middle of the key exchange. The terminal is
 * the trusted surface precisely BECAUSE the page cannot draw it, and escape
 * sequences were handing the page a pen.
 *
 * Rejecting at the wire rather than escaping at each print, because there is
 * no list of print sites to keep current — the daemon CLI, the connect CLI,
 * logs, and every surface not written yet all consume the same field. Bytes
 * that can only be an attack should not become values.
 *
 * NOT applied to content: prompt text, agent output, plan steps and a user's
 * own typed answers legitimately contain newlines, and they are payload
 * rendered as data rather than chrome read as truth. The split is the whole
 * design — see `messages.ts`, where `text` stays `str`.
 *
 * Scope, stated rather than assumed. This rejects the set whose attack was
 * demonstrated. Bidi overrides (U+202A-202E, U+2066-2069) can reorder
 * rendered text and are a plausible second vector on the same surfaces; they
 * are NOT rejected here, because "plausible" and "demonstrated" are different
 * evidentiary standards and bundling them would hide which one this bound
 * rests on. Zero-width joiners are deliberately allowed regardless — U+200D
 * is load-bearing inside ordinary emoji, so banning it would break correct
 * text to prevent nothing yet shown.
 */
export function display(min: number, max: number): Schema<string> {
  return described({ k: 'display', min, max }, (value, path) => {
    if (typeof value !== 'string') throw new WireViolation('wrong_type', path);
    if (value.length < min) throw new WireViolation('too_short', path);
    if (value.length > max) throw new WireViolation('too_long', path);
    if (CONTROL_CHARS.test(value)) throw new WireViolation('bad_format', path);
    return wellFormed(value, path);
  });
}

/**
 * String matching an anchored, linear-time pattern, length-capped before the
 * regex runs so a pathological input cannot buy CPU with size.
 */
export function pattern(re: RegExp, maxLength: number): Schema<string> {
  // `g` and `y` make .test() stateful via lastIndex — the same input would
  // then alternate pass/fail across calls. Reject the flag rather than
  // silently resetting it, so the mistake surfaces at module load.
  if (re.global || re.sticky) throw new Error(`wire pattern must not be global or sticky: ${re}`);
  return described({ k: 'pattern', re: re.source, max: maxLength }, (value, path) => {
    if (typeof value !== 'string') throw new WireViolation('wrong_type', path);
    if (value.length > maxLength) throw new WireViolation('too_long', path);
    if (!re.test(value)) throw new WireViolation('bad_format', path);
    return value;
  });
}

/** Exactly `byteLength` bytes of canonical lowercase hex. */
export function hex(byteLength: number): Schema<string> {
  const chars = byteLength * 2;
  return described({ k: 'hex', min: byteLength, max: byteLength }, (value, path) => {
    if (typeof value !== 'string') throw new WireViolation('wrong_type', path);
    if (value.length !== chars) throw new WireViolation('bad_format', path);
    // `*` not `+`: a zero-byte field's only valid encoding is the empty string.
    if (!/^[0-9a-f]*$/.test(value)) throw new WireViolation('bad_format', path);
    return value;
  });
}

/** Lowercase hex encoding between minBytes and maxBytes of payload. */
export function hexRange(minBytes: number, maxBytes: number): Schema<string> {
  return described({ k: 'hexRange', min: minBytes, max: maxBytes }, (value, path) => {
    if (typeof value !== 'string') throw new WireViolation('wrong_type', path);
    if (value.length % 2 !== 0) throw new WireViolation('bad_format', path);
    if (value.length < minBytes * 2) throw new WireViolation('too_short', path);
    if (value.length > maxBytes * 2) throw new WireViolation('too_long', path);
    if (!/^[0-9a-f]*$/.test(value)) throw new WireViolation('bad_format', path);
    return value;
  });
}

export function arr<T>(item: Schema<T>, maxLength: number): Schema<T[]> {
  return described({ k: 'arr', max: maxLength, of: wireShapeOf(item as Schema<unknown>) }, (value, path) => {
    if (!Array.isArray(value)) throw new WireViolation('wrong_type', path);
    if (value.length > maxLength) throw new WireViolation('too_many', path);
    const out: T[] = [];
    for (let i = 0; i < value.length; i++) {
      // Index-by-index, not .map(): map SKIPS holes, so a sparse array would
      // slip past both the item schema and the length the encoder emits.
      // JSON.parse cannot make holes, but an in-process caller can.
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw new WireViolation('wrong_type', `${path}[${i}]`);
      }
      out.push(item(value[i], `${path}[${i}]`));
    }
    return out;
  });
}

/**
 * Exact-shape object: every listed key validates, every unlisted key rejects.
 * The offending key's name is attacker-chosen and therefore never enters the
 * violation — only the path of the object that carried it.
 */
export function obj<S extends Shape>(shape: S): Schema<ObjOut<S>> {
  const fields = Object.entries(shape).map(([key, field]) => ({
    key,
    optional: 'optional' in field && field.optional === true,
    schema: ('optional' in field && field.optional === true ? field.schema : field) as Schema<unknown>,
  }));
  const known = new Set(fields.map((f) => f.key));
  const shape_: WireShape = {
    k: 'obj',
    fields: fields.map((f) => ({ key: f.key, optional: f.optional, of: wireShapeOf(f.schema) })),
  };
  return described(shape_, (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new WireViolation('wrong_type', path);
    }
    for (const key of Object.keys(value)) {
      if (!known.has(key)) throw new WireViolation('unexpected_key', path);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      // An own key whose value is `undefined` counts as ABSENT: canonicalJson
      // (like JSON.stringify) drops it, so treating it as present would make
      // an in-memory object fail a check its own wire form passes. Unknown
      // keys still reject whatever their value, because that is a typo worth
      // hearing about and the wire can never produce one.
      const present =
        Object.prototype.hasOwnProperty.call(source, field.key) && source[field.key] !== undefined;
      if (!present) {
        if (field.optional) continue;
        throw new WireViolation('missing_key', path === '' ? field.key : `${path}.${field.key}`);
      }
      out[field.key] = field.schema(source[field.key], path === '' ? field.key : `${path}.${field.key}`);
    }
    return out as ObjOut<S>;
  });
}

/**
 * Arbitrary JSON value (tool schemas, arguments, results, context), bounded
 * in depth, node count, and leaf-string length. Assumes JSON-parsed input:
 * the wire path guarantees plain data, and the walker re-checks that only
 * null/boolean/finite-number/string/array/plain-object appear so the same
 * schema stays safe on postMessage boundaries.
 *
 * "__proto__" keys are rejected even inside embedded JSON: JSON.parse makes
 * them harmless own properties, but the first consumer that Object.assigns
 * the value onto a target hits the prototype setter. Cutting the class off
 * at the boundary is cheaper than auditing every consumer forever.
 */
export function jsonValue(
  maxDepth: number,
  maxNodes: number,
  maxLeafChars: number,
): Schema<unknown> {
  return described({ k: 'json', record: false, depth: maxDepth, nodes: maxNodes, leaf: maxLeafChars }, (value, path) => {
    let nodes = 0;
    // Rebuilds as it walks, like obj(): a handler never receives the parsed
    // input itself, so no aliasing, no getters, no surprise prototype.
    const walk = (v: unknown, depth: number): unknown => {
      if (++nodes > maxNodes) throw new WireViolation('too_many', path);
      if (depth > maxDepth) throw new WireViolation('too_deep', path);
      if (v === null) return null;
      switch (typeof v) {
        case 'boolean':
          return v;
        case 'number':
          if (!Number.isFinite(v) || Object.is(v, -0)) throw new WireViolation('wrong_type', path);
          return v;
        case 'string':
          if (v.length > maxLeafChars) throw new WireViolation('too_long', path);
          return wellFormed(v, path);
        case 'object': {
          if (Array.isArray(v)) {
            const items: unknown[] = [];
            for (let i = 0; i < v.length; i++) {
              if (!Object.prototype.hasOwnProperty.call(v, i)) throw new WireViolation('wrong_type', path);
              items.push(walk(v[i], depth + 1));
            }
            return items;
          }
          const proto = Object.getPrototypeOf(v);
          if (proto !== Object.prototype && proto !== null) {
            throw new WireViolation('wrong_type', path);
          }
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(v)) {
            // JSON.parse makes "__proto__" a harmless own property, but the
            // first consumer that Object.assigns the value onto a target hits
            // the prototype setter. Cut the class off here rather than
            // auditing every consumer forever.
            if (key === '__proto__') throw new WireViolation('bad_format', path);
            if (key.length > maxLeafChars) throw new WireViolation('too_long', path);
            wellFormed(key, path);
            out[key] = walk((v as Record<string, unknown>)[key], depth + 1);
          }
          return out;
        }
        default:
          throw new WireViolation('wrong_type', path);
      }
    };
    return walk(value, 1);
  });
}

/**
 * Like jsonValue but the top level must be a plain object, so fields typed
 * `Record<string, unknown>` (tool inputSchema, call arguments, context) are
 * honest at runtime — an array or scalar cannot type-lie its way into a
 * handler expecting an object.
 */
export function jsonRecord(
  maxDepth: number,
  maxNodes: number,
  maxLeafChars: number,
): Schema<Record<string, unknown>> {
  const inner = jsonValue(maxDepth, maxNodes, maxLeafChars);
  return described({ k: 'json', record: true, depth: maxDepth, nodes: maxNodes, leaf: maxLeafChars }, (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new WireViolation('wrong_type', path);
    }
    return inner(value, path) as Record<string, unknown>;
  });
}

/**
 * Cross-field consistency on top of a structural schema. The predicate runs
 * on the validated value and returns a violation code to reject, or null to
 * accept — it never sees unvalidated input.
 */
export function refined<T>(
  schema: Schema<T>,
  predicate: (value: T) => ViolationCode | null,
): Schema<T> {
  return described({ k: 'refined', of: wireShapeOf(schema as Schema<unknown>) }, (value, path) => {
    const validated = schema(value, path);
    const code = predicate(validated);
    if (code !== null) throw new WireViolation(code, path);
    return validated;
  });
}
