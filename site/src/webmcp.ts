import type { SiteTool } from '@agentport/client';

interface WebMcpToolLike {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  execute?: unknown;
  annotations?: unknown;
}

interface ModelContextLike {
  provideContext?: (context: { tools?: unknown }) => unknown;
  registerTool?: (tool: unknown) => unknown;
}

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

function modelContext(environment: WebMcpEnvironment): ModelContextLike | undefined {
  const current = environment.document?.modelContext;
  if (isRecord(current)) return current as ModelContextLike;
  const legacy = environment.navigator?.modelContext;
  return isRecord(legacy) ? legacy as ModelContextLike : undefined;
}

/**
 * WebMCP exposes registration calls, not a public registry to enumerate. Observe
 * those calls early, but convert their live contents only when connect happens.
 */
export function createWebMcpHarvester(environment: WebMcpEnvironment): WebMcpHarvester {
  const registrations = new Map<string, WebMcpToolLike>();
  let observed: ModelContextLike | undefined;

  const adopt = (list: unknown, replace = false): void => {
    if (replace) registrations.clear();
    if (!Array.isArray(list)) return;
    for (const entry of list as WebMcpToolLike[]) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.execute !== 'function') continue;
      registrations.set(entry.name, entry);
    }
  };

  const observe = (): void => {
    const context = modelContext(environment);
    if (!context || context === observed) return;
    observed = context;

    const provideContext = context.provideContext;
    if (typeof provideContext === 'function') {
      context.provideContext = function (this: unknown, value: { tools?: unknown }) {
        adopt(value?.tools, true);
        return provideContext.call(this, value);
      };
    }

    const registerTool = context.registerTool;
    if (typeof registerTool === 'function') {
      context.registerTool = function (this: unknown, tool: unknown) {
        adopt([tool]);
        return registerTool.call(this, tool);
      };
    }
  };

  // Native WebMCP exists before page scripts run, so observing when connect.js
  // loads captures registrations made later. `harvest()` observes again for a
  // modelContext supplied by a late polyfill.
  observe();

  return {
    harvest(explicit = []) {
      observe();
      const merged = new Map<string, SiteTool>();
      for (const entry of registrations.values()) {
        const execute = entry.execute as (args: Record<string, unknown>) => unknown;
        const annotations = isRecord(entry.annotations) ? entry.annotations : {};
        merged.set(entry.name as string, {
          name: entry.name as string,
          description: typeof entry.description === 'string' ? entry.description : entry.name as string,
          inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: 'object' },
          ...(annotations['destructiveHint'] === true ? { requiresApproval: true } : {}),
          handler: (args) => execute.call(entry, args),
        });
      }
      for (const tool of explicit) merged.set(tool.name, tool);
      return [...merged.values()];
    },
  };
}
