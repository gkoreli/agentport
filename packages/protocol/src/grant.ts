/**
 * What a capability grant means at the moment somebody has to act on it.
 *
 * Today that is one question — "does this tool ask again?" — and it was spelled
 * out seven times: twice in the daemon, once in the client session, and four
 * times on CONSENT SURFACES, where the answer is what a user reads before
 * deciding. Four independent renderings of one rule is four chances for the
 * screen to promise something the enforcement does not do.
 *
 * NON-GOAL, stated so the next person does not do it here: `buildGrant` and
 * `explainGrantViolation` stay in `packages/client/src/wallet.ts`. They belong
 * to the DEVELOPER boundary — they translate a WireViolation into advice for
 * whoever typed the tool list — and moving them is scheduled work of its own,
 * not a side effect of consolidating this predicate.
 */

import { canonicalJson } from './crypto.js';

/**
 * Does this tool require an approval round-trip on every invocation?
 *
 * The tool's own hint, OR the grant naming it in `alwaysAsk` — the grant wins
 * because the user's wallet writes `alwaysAsk` and the site writes
 * `requiresApproval`, so the two are not equally trusted and the union is
 * always the safe combination.
 *
 * Both parameters are structural rather than `ToolDefinition`/`CapabilityGrant`
 * because the call sites are not all holding wire types: the extension's
 * consent window and the Inkwell demo hold a page connect request whose
 * `alwaysAsk` is optional, and the hosted wallet holds a grant that may not
 * have arrived yet.
 *
 * `Boolean(...)`, not `=== true`, resolving the drift the seven copies had:
 * the two spellings differ only on a value the wire schema refuses
 * (`requiresApproval` is `opt(bool())`), and where they differ the truthy one
 * gates and the strict one does not. When two copies of a rule disagree, keep
 * the one that asks the user.
 */
export function isGated(
  tool: { name: string; requiresApproval?: boolean | undefined },
  grant: { alwaysAsk?: readonly string[] | undefined },
): boolean {
  return Boolean(tool.requiresApproval) || (grant.alwaysAsk?.includes(tool.name) ?? false);
}

/**
 * Would replacing `prev` with `next` give the attachment ANY authority it
 * does not already hold? (v7, the `grant.update` judge.)
 *
 * The asymmetry this decides: a narrowing update needs nothing beyond being
 * the session's own client, a widening one needs fresh user-signed authority
 * — so this predicate is the entire boundary between "the page tidied up
 * after a toolchange" and "the page grew its own grant mid-session"
 * (invariant 2). It errs WIDE on purpose: anything it cannot prove is a pure
 * narrowing is treated as widening, because the cost of a false "wider" is
 * one extra signature, and the cost of a false "narrower" is an authority
 * nobody approved.
 *
 * Wider means any of:
 *  - a tool name `prev` does not grant;
 *  - a surviving tool whose description or input schema CHANGED — the model
 *    reads both, so a mutation is a new capability wearing an approved name
 *    (and, mid-session, an instruction-injection channel);
 *  - a surviving tool that was gated in `prev` and is not gated in `next`;
 *  - a later `expiresAt`.
 *
 * Everything else — dropped tools, added gates, an earlier expiry — is
 * narrowing.
 */
export function grantWiderThan(
  next: {
    tools: readonly { name: string; description: string; inputSchema: Record<string, unknown>; requiresApproval?: boolean | undefined }[];
    alwaysAsk: readonly string[];
    expiresAt: number;
  },
  prev: {
    tools: readonly { name: string; description: string; inputSchema: Record<string, unknown>; requiresApproval?: boolean | undefined }[];
    alwaysAsk: readonly string[];
    expiresAt: number;
  },
): boolean {
  if (next.expiresAt > prev.expiresAt) return true;
  const previous = new Map(prev.tools.map((tool) => [tool.name, tool]));
  for (const tool of next.tools) {
    const held = previous.get(tool.name);
    if (!held) return true;
    if (tool.description !== held.description) return true;

    if (canonicalJson(tool.inputSchema) !== canonicalJson(held.inputSchema)) return true;
    if (isGated(held, prev) && !isGated(tool, next)) return true;
  }
  return false;
}
