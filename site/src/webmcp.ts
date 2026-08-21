/**
 * connect.js's half of WebMCP harvesting: probe, wire, snapshot.
 *
 * There is deliberately no contract knowledge in this file. What WebMCP is,
 * what we accept from a page, what we produce, and why a harvested tool is
 * always gated all live in `packages/client/src/webmcp.ts` — one artifact, so
 * the next person diffs the draft against ONE file rather than two harvesters
 * that drifted apart once already.
 *
 * connect.js never installs a shim. A site that loads connect.js has an
 * AgentPort integration and declares its tools through `connect()`; standing a
 * fake `document.modelContext` up in its page would invent a second way to say
 * the same thing. The extension is the surface that meets sites which never
 * heard of us, so the shim belongs to it.
 */

import { createWebMcpRegistry, type ModelContextLike, type SiteTool } from '@agentport/client';
import { createLogger } from '@agentport/protocol';

// Deliberately not `siteLogger` from ./observe.js: that module touches `window`
// at import time, and this one is exercised by `npm run webmcp:harvest` under
// plain Node. Same component prefix, same ring buffer, so
// `window.__agentport.logs()` shows these lines either way.
const log = createLogger('site.webmcp');

export interface WebMcpEnvironment {
  document?: { modelContext?: unknown };
  navigator?: { modelContext?: unknown };
}

export interface WebMcpHarvester {
  /** Snapshot the registrations now; explicit SiteTools own name collisions. */
  harvest(explicit?: readonly SiteTool[]): SiteTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `document.modelContext` first, `navigator.modelContext` only as a fallback.
 * The getter moved to Document on 2026-05-27 and Chrome deprecated the
 * navigator spelling in 150; sites and polyfills written before that are still
 * out there, which is the documented reason the older spelling has a tier
 * rather than being leftovers.
 */
function modelContext(environment: WebMcpEnvironment): ModelContextLike | undefined {
  const current = environment.document?.modelContext;
  if (isRecord(current)) return current as ModelContextLike;
  const legacy = environment.navigator?.modelContext;
  return isRecord(legacy) ? (legacy as ModelContextLike) : undefined;
}

export function createWebMcpHarvester(
  environment: WebMcpEnvironment,
  options: { logger?: ReturnType<typeof createLogger> } = {},
): WebMcpHarvester {
  const logger = options.logger ?? log;
  let harvested = false;
  const registry = createWebMcpRegistry({
    logger,
    onChange: () => {
      // Registrations while the page loads are ordinary; a change AFTER the
      // snapshot was taken means the lent set is stale for as long as the
      // session lives. Surfaced rather than silent — and it can go no
      // further: the session grant is frozen at attach, until the
      // `grant.update` frame (protocol v7) gives a change somewhere to go.
      if (!harvested) return;
      logger.info('webmcp tools changed after harvest; the session grant is frozen until grant.update lands', {
        data: { tools: registry.size() },
      });
    },
  });

  const observe = (): void => {
    const context = modelContext(environment);
    if (context) registry.observe(context);
  };

  // A native implementation exists before page scripts run, so wrapping when
  // connect.js loads catches everything the page registers afterwards.
  // `harvest()` observes again for a model context a late polyfill installed.
  observe();

  return {
    harvest(explicit = []) {
      observe();
      harvested = true;
      const merged = new Map<string, SiteTool>();
      for (const tool of registry.tools()) merged.set(tool.name, tool);
      // The site's own `connect()` tools win a name collision: those came from
      // an integration the site wrote against us, and they carry the site's
      // own handler.
      for (const tool of explicit) merged.set(tool.name, tool);
      return [...merged.values()];
    },
  };
}
