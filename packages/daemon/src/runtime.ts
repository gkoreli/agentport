import type { CapabilityGrant, HistoryEntry, SurfaceDescriptor, ToolDefinition } from '@agentport/protocol';

/**
 * Everything a runtime is handed for one turn.
 *
 * `tools` are the site's tools, valid only for this session — this is the
 * "temporary capability injection" the whole project exists for. A real
 * adapter (Claude Code, an ACP harness, goose) registers these as MCP tools
 * on session start and unregisters them on session close.
 */
export interface TurnContext {
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  tools: ToolDefinition[];
  /** Streamed to the user as assistant output. */
  say(text: string): void;
  /** Streamed to the user as status/reasoning, rendered separately. */
  think(text: string): void;
  /** Invoke one of the site's tools. Rejects if the site refuses or errors. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Ask the user to approve something. Resolves false if declined. */
  requestApproval(summary: string, call?: { name: string; arguments: Record<string, unknown> }): Promise<boolean>;
  /** Aborts when the client cancels the prompt or closes the session. */
  signal: AbortSignal;
}

export interface AgentRuntime {
  readonly name: string;
  /**
   * Replay the conversation from the runtime's OWN store, if it keeps one.
   *
   * This is the provenance answer: ACP agents already persist sessions on the
   * user's disk (claude-agent-acp advertises `loadSession`), so history is
   * read back from there rather than duplicated into the relay, the website,
   * or a second transcript of ours. Return null when the runtime has no store
   * and the daemon should fall back to what it observed.
   */
  replayHistory?(): Promise<HistoryEntry[] | null>;
  /** Called once per session before the first prompt. */
  openSession?(context: Omit<TurnContext, 'say' | 'think' | 'callTool' | 'requestApproval' | 'signal'>): Promise<void> | void;
  closeSession?(): Promise<void> | void;
  prompt(text: string, context: TurnContext): Promise<void>;
}

/** Minimal runtime used by tests and `--runtime echo`. */
export class EchoRuntime implements AgentRuntime {
  readonly name = 'echo';

  async prompt(text: string, ctx: TurnContext): Promise<void> {
    ctx.think(`${ctx.tools.length} tool(s) available from ${ctx.surface.name}`);
    for (const word of `you said: ${text}`.split(' ')) {
      if (ctx.signal.aborted) return;
      ctx.say(word + ' ');
    }
  }
}

/**
 * Exercises the full protocol surface without an LLM: reads the document,
 * asks for approval, then writes through a site tool.
 *
 * This is what a real adapter's tool loop looks like, minus the model.
 */
export class DemoWriterRuntime implements AgentRuntime {
  readonly name = 'demo-writer';

  async prompt(text: string, ctx: TurnContext): Promise<void> {
    const has = (name: string) => ctx.tools.some((tool) => tool.name === name);

    if (!has('inkwell.document.read')) {
      ctx.say(`No document tools were granted, so I can only talk. You said: ${text}`);
      return;
    }

    ctx.think('reading the current document');
    const doc = (await ctx.callTool('inkwell.document.read', {})) as { text?: string };
    const body = doc?.text ?? '';
    ctx.say(`I read ${body.length} characters. `);

    if (!has('inkwell.document.replaceSelection')) {
      ctx.say('I have no way to write back, so here is a suggestion instead: tighten the opening sentence.');
      return;
    }

    const replacement = body.trim().length > 0 ? `${body.trim()}\n\n${text}` : text;
    const approved = await ctx.requestApproval('Append your instruction to the document', {
      name: 'inkwell.document.replaceSelection',
      arguments: { text: replacement },
    });

    if (!approved) {
      ctx.say('Understood — I left the document untouched.');
      return;
    }

    await ctx.callTool('inkwell.document.replaceSelection', { text: replacement });
    ctx.say('Done. The document now ends with your instruction.');
  }
}

export const RUNTIMES: Record<string, () => AgentRuntime> = {
  echo: () => new EchoRuntime(),
  'demo-writer': () => new DemoWriterRuntime(),
};

/** Registered separately so the demo runtimes stay dependency-free. */
export function registerRuntime(name: string, create: () => AgentRuntime): void {
  RUNTIMES[name] = create;
}
