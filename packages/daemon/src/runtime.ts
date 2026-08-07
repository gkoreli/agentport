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
 *
 * Build one with `attachmentPolicy()`. There is no other constructor on
 * purpose: every field here answers the SAME question, so the only input is
 * that question's answer and no caller can hand two fields values that
 * disagree.
 */
export interface AttachmentPolicy {
  /**
   * Whether the agent may ask its own user a question. False on any tier
   * whose answer surface the requesting origin could draw, read or forge; a
   * runtime that sees false must not advertise the capability to its agent,
   * so the agent has no ask affordance rather than asking into silence.
   */
  mayAsk: boolean;
  /**
   * Whether the agent may use its OWN capabilities — its shell, its files,
   * whatever its runtime carries — during this attachment (ADR-024 R11).
   *
   * An own-tool approval asks the user to lend the agent authority over their
   * own machine, so it may only be answered on a surface the requesting
   * origin cannot draw. Where no such surface exists there is nobody who may
   * answer, and the rule is refuse rather than reroute: the delegated tier's
   * only candidate surfaces are a popup that cannot be opened without a user
   * gesture the agent does not have, and an iframe the page can cover.
   *
   * The site's OWN tools are unaffected, and that asymmetry is the whole
   * point: a site forging approval for its own function gains nothing it did
   * not already have, while forging approval for the user's shell is
   * escalation.
   */
  mayUseOwnTools: boolean;
}

/**
 * Derive an attachment's whole policy from the ONE question it turns on: does
 * this attachment have an answer surface the requesting origin cannot draw,
 * read or forge?
 *
 * One input, deliberately. Both fields would otherwise be two booleans that
 * agree today and drift the first time somebody changes one — silently, since
 * agreeing is not a thing a compiler can check. A future field goes here as
 * another derivation of the same argument; a field that genuinely needs a
 * second input changes this signature, which is a change a reviewer sees.
 */
export function attachmentPolicy(hasTrustedAnswerSurface: boolean): AttachmentPolicy {
  return { mayAsk: hasTrustedAnswerSurface, mayUseOwnTools: hasTrustedAnswerSurface };
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
 * then writes through a site tool.
 *
 * This is what a real adapter's tool loop looks like, minus the model — and
 * that includes NOT asking `requestApproval` about a site tool it is about to
 * call. `requestApproval` is a runtime's own advisory channel, so the daemon
 * stamps everything arriving on it `runtime_own_tool` (ADR-023 R2), and under
 * ADR-024 R11 that authority is refused wherever the page is the only surface
 * that could answer. A demo that asked there would simply stop writing on the
 * tier the site actually uses. The real adapter never asks either: AcpRuntime
 * short-circuits granted MCP names before they reach this channel (acp.ts),
 * because the gate that matters for a site tool is the browser's own
 * `requiresApproval` check on the `tool.call` — which asks the user exactly
 * once, in the surface that owns that tool.
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
      { text: 'Choose how to write it back', status: 'pending' },
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

    advance(1);
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

    advance(2);
    // The surface's own gate lives on this call: a tool marked
    // `requiresApproval`, or named in the grant's `alwaysAsk`, is put to the
    // user before its handler runs, as `site_tool`. A decline arrives here as
    // a rejected call, which is the honest shape — the tool did not run.
    try {
      await ctx.callTool(writer.name, writer.args(text));
    } catch (err) {
      // Not swallowed: the daemon logs every failing surface call with its
      // session and tool, and the runtime's job here is the other half of the
      // rule — telling the user, in the conversation, that nothing was
      // written and why.
      ctx.say(`Understood — I left the document untouched (${err instanceof Error ? err.message : String(err)}).`);
      return;
    }
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
