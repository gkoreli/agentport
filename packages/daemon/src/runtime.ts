import type {
  CapabilityGrant,
  FormField,
  HistoryEntry,
  PlanStep,
  SurfaceDescriptor,
  ToolDefinition,
} from '@agentport/protocol';

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
  /**
   * Report the agent's plan for this turn, as a whole.
   *
   * A snapshot, not a delta: each call replaces the previous plan, because
   * runtimes rewrite plans as they discover work. Runtimes that report no
   * plan simply never call this.
   */
  plan(steps: PlanStep[]): void;
  /** Invoke one of the site's tools. Rejects if the site refuses or errors. */
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Ask the user to approve something. Resolves false if declined. */
  requestApproval(
    summary: string,
    call?: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<boolean>;
  /**
   * Ask the user a question and wait for their answer (ADR-024).
   *
   * Resolves `undefined` when the user skipped, when nobody answered in time,
   * or when the turn was cancelled — all of which mean "proceed without an
   * answer", never "abort". Losing the user's work because they did not
   * answer a question is a worse failure than continuing without one, which
   * is also what the agent's own built-in ask does.
   *
   * Only reachable when the attachment's policy permits it; on a tier whose
   * answer surface the requesting origin could forge, the capability is never
   * declared and the agent has no ask affordance at all.
   */
  ask(question: AskQuestion, signal?: AbortSignal): Promise<AskAnswers | undefined>;
  /** Aborts when the client cancels the prompt or closes the session. */
  signal: AbortSignal;
}

/**
 * What this attachment is permitted to do, decided by the daemon — which
 * knows which tier answers its questions — and never by the runtime.
 */
export interface AttachmentPolicy {
  /**
   * Whether the agent may ask its own user a question. False on any tier
   * whose answer surface the requesting origin could draw, read or forge; a
   * runtime that sees false must not advertise the capability to its agent,
   * so the agent has no ask affordance rather than asking into silence.
   *
   * Every field here is decided by the daemon from ONE predicate — does a
   * surface exist that the requesting origin cannot draw — because they all
   * turn on the same question. Add a field by deriving it from that
   * predicate, not by adding a second boolean that happens to agree: two
   * booleans that agree today drift silently, since agreeing is not
   * something a compiler can check.
   */
  mayAsk: boolean;
}

/** One question, already narrowed to what a consent surface can render. */
export interface AskQuestion {
  message: string;
  fields: FormField[];
}

/** Field key to the user's answer. Absent keys were left blank. */
export type AskAnswers = Record<string, string>;

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
  openSession?(
    context: Omit<TurnContext, 'say' | 'think' | 'plan' | 'callTool' | 'requestApproval' | 'ask' | 'signal'> & {
      /**
       * Attachment POLICY, as distinct from attachment content (ADR-024 R5).
       *
       * An object rather than a boolean deliberately: Gate C's own-tool
       * allowlist needs exactly this channel next, and a one-off flag now
       * would mean a real policy object three weeks later.
       */
      policy: AttachmentPolicy;
    },
  ): Promise<void> | void;
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

    // The plan is reported as a whole and re-reported as it advances, which is
    // what a real runtime does — this demo exists to exercise that path.
    const steps: PlanStep[] = [
      { text: 'Read the current document', status: 'active' },
      { text: 'Ask before writing', status: 'pending' },
      { text: 'Write the change', status: 'pending' },
    ];
    const advance = (index: number): void => {
      for (const [at, step] of steps.entries()) {
        step.status = at < index ? 'done' : at === index ? 'active' : 'pending';
      }
      ctx.plan(steps.map((step) => ({ ...step })));
    };
    advance(0);

    ctx.think('reading the current document');
    const doc = (await ctx.callTool('inkwell.document.read', {})) as { text?: string };
    const body = doc?.text ?? '';
    ctx.say(`I read ${body.length} characters. `);

    // Write through whichever mutation tool the surface granted.
    const writer = has('inkwell.document.replaceSelection')
      ? { name: 'inkwell.document.replaceSelection', args: (t: string) => ({ text: `${body.trim()}\n\n${t}`.trim() }) }
      : has('inkwell.document.append')
        ? { name: 'inkwell.document.append', args: (t: string) => ({ text: t }) }
        : undefined;
    if (!writer) {
      ctx.say('I have no way to write back, so here is a suggestion instead: tighten the opening sentence.');
      return;
    }

    advance(1);
    const approved = await ctx.requestApproval('Write your instruction into the document', {
      name: writer.name,
      arguments: writer.args(text),
    });

    if (!approved) {
      ctx.say('Understood — I left the document untouched.');
      return;
    }

    advance(2);
    await ctx.callTool(writer.name, writer.args(text));
    advance(steps.length);
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
