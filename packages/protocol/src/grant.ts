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
