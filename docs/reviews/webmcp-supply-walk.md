# The WebMCP supply, walked — 2026-08-21

The landscape research said tool supply arrived in August 2026: a Chrome
origin trial, a Cloudflare edge-injection preview, and a report — secondary,
unconfirmed — that Shopify had switched WebMCP on across Liquid storefronts.
This walk went and looked, from the only position the north star says counts:
outside, with nothing but our extension installed. The instruments are
`scripts/walk-webmcp.ts` (registry and harvest observation per URL) and
`scripts/walk-flagship.ts` (the full attach-and-turn attempt). Both are a
person's tools, not gates: they drive the live web, and a red is a finding
about the world.

Method: Chrome for Testing 151 (headless), the unpacked extension built from
this tree, one tab per site, bounded waits, a page-world probe that reads —
never infers — who supplied `modelContext`, what `getTools()` lists, what the
page's own supply believes, and whether our harvest's wrapper is the function
registrations actually flow through.

## Findings, per site

| site | modelContext | supplier | tools listed | our wrapper in place |
|---|---|---|---|---|
| allbirds.com | yes | browser (prototype) | **10 commerce tools** | **yes** |
| kith.com | yes | browser (prototype) | **10 commerce tools** | yes |
| brooklinen.com | yes | browser (prototype) | **10 commerce tools** | yes |
| gymshark.com (control) | yes | browser (prototype) | 0 | yes |
| chromelabs explainer demo | yes | browser (prototype) | 3 (booking) | yes |
| chromelabs pizza-maker demo | yes | browser (prototype) | 7 | yes |

The ten tools on every Liquid storefront, identically: `browse_store`,
`search_catalog`, `get_product`, `get_cart`, `update_cart`,
`proceed_to_checkout`, `manage_orders`, `cancel_cart`, `show_variant`,
`search_shop_policies_and_faqs`.

## What the walk established

**1. The Shopify report is true, and it is primary now.** The served HTML of
each Liquid storefront carries `window.Shopify.MCP.enabled = true`, an inline
tool declaration, and a loader for
`cdn.shopify.com/storefront/webmcp/webmcp-0.1.1.js`. The adapter registers ten
real commerce tools through `modelContext.registerTool`. Gymshark (not
Liquid) carries none — a clean negative control.

**2. The adapter registers into whatever registry exists, and no-ops
otherwise.** Read from the adapter source, not inferred: its lookup takes
`document.modelContext`, falls back to `navigator.modelContext`, and if
neither exists it registers nothing. It ships no polyfill. Two consequences.
In a browser without the API and without us, this supply is dormant. In a
browser without the API but WITH our extension, our shim
(`packages/extension/src/inpage.ts#installWebMcp`) IS the registry the
adapter finds — the supply lights up because the user brought an agent.

**3. Chrome for Testing 151 ships `modelContext` natively** — on the
prototype, present on every page walked. So on current Chrome the API side of
the origin trial is real, and our extension takes its observe path: it wraps
`registerTool` on the native registry
(`packages/client/src/webmcp.ts#createWebMcpRegistry`, the `observe` member)
rather than replacing it. The walk proved the wrap live: on every page, the
registry's `registerTool` no longer stringifies as native code — **the ten
Shopify registrations flowed through our harvester** — and a canary
registration became listable and was withdrawn through its abort signal.

**4. Nothing excluded us — today.** `exposedTo` restricts which DOCUMENTS may
access a tool; the Shopify adapter registers without it, and our extension
operates in the page's own world, so it sees what the page sees. The
explainer's exposure defaults ("built-in browser agents") govern a
consumption surface that did not bite on any walked page. That is the current
truth and also the fragile one: it holds because we harvest at registration
time in page world, not because any spec text names us. The
fourth-consumer-class argument (`docs/standards/`) now has live evidence on
both sides — the supply is real, and our access to it is an accident of
mechanism rather than a named right.

**5. Cloudflare's preview is real but not yet walkable.** The bridge path
(`/.webmcp/bridge.js`) answers 404 on Cloudflare's own properties and on
every storefront probed; the announcement names no demo site. Nothing to
walk yet; the probe is one curl when a site appears.

**6. Two of our own claims failed the walk.** AGENTS.md says a page's ring
buffer is inspectable via `window.__agentport?.logs()` — no such surface
exists anywhere in this tree's source; the walk had to fingerprint the
wrapper instead. And `webmcp-supply` walking exposed that the harvest logs
its per-tool line at debug into a sink no page can reach, so "did the harvest
see it" is unanswerable from outside without the wrapper fingerprint. Both
are small; both are the kind of drift only a walk finds.

## The flagship attempt

The full demo — this machine's own authenticated Claude Code, attached
through the extension to allbirds.com, lent the storefront's ten tools, one
read-only turn — is scripted end to end in `scripts/walk-flagship.ts`: real
relay, real daemon, real consent chrome driven per-window, approvals granted
only to read-shaped tools, nothing carted or bought. Pairing's outcome is
seeded on both ends (the round-trip is e2e-proven; the walk's subject is the
attach and the turn).

Outcome, from the runs of 2026-08-21 (log excerpts and the five screenshots
in `assets/` are the evidence):

- The extension seeded, dialed the local relay, and the page-provider
  `navigator.agent.connect()` on allbirds.com opened the extension's consent
  window: verified origin, the walked agent, the ten harvested tools. The
  page was told `agentName: "Personal agent"` and a per-origin alias — the
  ADR-009 disclosure rule holding on a real site.
- The first attempt was REFUSED by the daemon's decoder:
  `bad_format at grant.tools[9].description`. Real supply writes multiline
  descriptions; the wire carries descriptions as `display()`, which refuses
  control characters. That is the walk doing its job — a defect no fixture
  had, found by the first real page. The harvest boundary now flattens
  control characters (`packages/client/src/webmcp.ts#toSiteTool`), with the
  case watched failing in `npm run webmcp:harvest`.
- With that fixed: one real Claude Code turn. The agent chose
  `search_catalog({"catalog":{"pagination":{"limit":3},"query":"shoes"}})`,
  the per-call approval window named the tool, its arguments, and the lender
  (`flagship-consent-2.png`), the approved call ran against Shopify's
  storefront MCP backend and answered in 665 ms with real product data, and
  the turn completed in 10.7 s.
- Also observed live, unprompted: stream D's per-origin enablement arrived
  mid-walk (the provider vanished on a default-OFF origin until the origin
  was enabled — the seeded toggle stood in for the user gesture), and stream
  P's shared agent process ended the run with
  `agent process stopped reason="last attachment closed"`.

The agent's answer, verbatim through the sealed session:

> This is Allbirds, a footwear store selling sustainably made shoes (plus
> related apparel and accessories). One example from the catalog: the Men's
> Allbirds Slide in Natural Black, priced at $55 USD.

The store answered a stranger's own agent, and the store never heard of us.

## Implications for the roadmap

1. **The wedge argument strengthened.** On today's Chrome the harvest path is
   not a fallback — three top-tier storefronts hand a user-supplied agent ten
   named commerce actions, and the generic page harness is the complement for
   the gymsharks. Distribution (phase 5) is confirmed as the binding
   constraint: everything walked here works only where the extension is
   installed.
2. **File the fourth consumer class now, with this walk attached.** Our
   access rests on observing page-world registrations before exposure
   semantics harden. The standards writeup should cite this walk as the
   existence proof that a user-supplied remote agent is a real consumer with
   real supply.
3. **`grant.update` has a live consumer.** The Shopify adapter registers
   after `DOMContentLoaded` on a deferred callback; an attachment made early
   holds a grant snapshot from before the supply arrived. The frame shipped
   in v7; wiring `toolchange` into it (stream I's recorded TODO) is what
   makes early attachment honest on exactly these pages.
