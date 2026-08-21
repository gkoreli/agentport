/**
 * Can the ACP agent this daemon is configured to drive actually be started?
 *
 * `AGENTPORT_RUNTIME` defaults to `claude-code`, which spawns the pair from
 * `packages/daemon/src/acp-command.ts#resolveAcpCommand` — by default
 * `npx -y @agentclientprotocol/claude-agent-acp` — and drives Claude Code over
 * ACP. That is an undeclared prerequisite: the program has to be fetchable,
 * runnable, and an ACP agent. Nothing checked it. The daemon dialled the relay,
 * printed a pairing code, a stranger paired, and the failure surfaced minutes
 * later inside `packages/daemon/src/runtimes/acp.ts#openSession` — in a
 * BROWSER, on the far side of a relay, as an opaque session error. The one
 * terminal that could fix it never heard a word.
 *
 * So the probe below runs in two places and is written once: `agentport
 * doctor` asks for it on demand, and `packages/daemon/src/cli.ts` runs it
 * before it dials anything.
 *
 * WHAT A GREEN PROBE PROVES, AND WHAT IT DOES NOT. A successful `initialize`
 * proves the command spawns and speaks ACP. It does NOT prove the agent is
 * authenticated: claude-agent-acp answers `initialize` happily with no
 * credentials and only reports a missing login once a prompt runs a model turn
 * (its `failActive(RequestError.authRequired())` lives in the query stream, not
 * in initialization). Proving authentication would therefore cost a real turn
 * on the user's own subscription at every daemon start. So this reports the
 * auth methods the agent advertises and says plainly that it did not test
 * them — AGENTS.md rule 8: when the only available check would lie, record the
 * gap and its cost instead.
 *
 * Performing an ACP `authenticate` is deliberately NOT implemented here or
 * anywhere else in this repo. Doctor tells you what authentication the agent
 * offers and the exact command to run; the user runs it. An AgentPort preflight
 * that logged a user into their model provider would be holding a credential
 * this project has no business touching.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AuthMethod,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import { createLogger, type LogSink } from '@agentport/protocol';
import { DEFAULT_ACP_COMMAND, resolveAcpCommand, type AcpCommand } from './acp-command.js';
import { registerRuntime } from './runtime.js';
import { AcpRuntime, terminateProcessTree } from './runtimes/acp.js';
import type { McpBridge } from './mcp-bridge.js';

/**
 * Hard bound on the whole probe — spawn, connect, initialize, answer.
 *
 * Sized for the slowest legitimate run rather than the common one. The default
 * command is `npx -y @agentclientprotocol/claude-agent-acp`, and on a machine
 * that has never fetched it npx downloads the adapter and its bundled Claude
 * CLI before a single ACP byte moves; a warm run answers in about a second. A
 * bound tight enough to feel pleasant would refuse to start daemons that would
 * have worked, on exactly the fresh VPS this exists to help — and a preflight
 * whose failure mode is "correct configuration rejected" is worse than no
 * preflight. 60s covers that cold fetch on a slow link, and still turns a
 * program that will never answer into a bounded failure rather than a hang
 * nobody can tell from slowness (AGENTS.md, what makes a check evidence, 3).
 */
export const ACP_PROBE_DEADLINE_MS = 60_000;

/**
 * How long a rejected `initialize` waits for the child's own exit event before
 * the protocol gets the blame. A dead process closes its stdout, which fails
 * every pending request, so the rejection usually lands first and says
 * something useless ("connection closed") about a binary that never existed.
 * The exit event carries the real cause, and it is right behind.
 */
const CHILD_SETTLE_MS = 250;

/** Bytes of the agent's stderr kept for the failure message. */
const MAX_STDERR_CHARS = 4_000;

/** How many trailing stderr lines a failure quotes. */
const STDERR_TAIL_LINES = 4;

/** Where the ACP agent's command pair came from, so remediation can differ. */
export type AcpSpawnSource = 'default' | 'env';

/** Everything needed to start the configured ACP agent, resolved once. */
export interface AcpSpawnTarget extends AcpCommand {
  /**
   * The directory the agent is started in, and the `cwd` its ACP session is
   * opened with — so, the project it is pointed at. AgentPort lends it no
   * filesystem capability of its own (`fs: false` at initialize), which means
   * everything it touches on disk it touches with its OWN tools under its own
   * rules; this is where those start. Default `process.cwd()`, which on a VPS
   * is wherever the service was launched from.
   */
  cwd: string;
  source: AcpSpawnSource;
}

/**
 * The runtime names an ACP agent backs — and the only place they are
 * registered. The list and the registration are kept in one function on
 * purpose: `isAcpRuntime` answers "would this daemon spawn an ACP agent for
 * that name?", and an answer produced by any list other than the one doing the
 * registering is an answer free to drift from the truth it describes.
 */
const ACP_RUNTIME_NAMES = ['claude-code', 'acp'] as const;

/** Resolve the command pair plus the directory the agent will run in. */
export function resolveAcpSpawn(env: Record<string, string | undefined>): AcpSpawnTarget | string {
  const pair = resolveAcpCommand(env);
  if (typeof pair === 'string') return pair;
  return {
    ...pair,
    cwd: env['AGENTPORT_AGENT_CWD'] ?? process.cwd(),
    source: env['AGENTPORT_ACP_COMMAND'] === undefined ? 'default' : 'env',
  };
}

/** Register every ACP-backed runtime name against one resolved command pair. */
export function registerAcpRuntimes(target: AcpSpawnTarget, bridge: McpBridge): void {
  for (const name of ACP_RUNTIME_NAMES) {
    registerRuntime(
      name,
      () => new AcpRuntime({ command: target.command, args: target.args, cwd: target.cwd, bridge }),
    );
  }
}

/** Would this runtime name spawn an ACP agent? */
export function isAcpRuntime(name: string): boolean {
  return (ACP_RUNTIME_NAMES as readonly string[]).includes(name);
}

/** The command as a person would type it, for reports and remediation. */
export function acpCommandLine(target: AcpCommand): string {
  return [target.command, ...target.args].join(' ');
}

/** One way the agent says it can be authenticated. Reported, never performed. */
export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
  /**
   * For ACP `terminal` methods: the extra arguments to run the agent binary
   * with. Rendered as a runnable command line for the reader.
   */
  terminalArgs?: string[];
}

export type AcpProbeFailure = 'spawn' | 'exit' | 'initialize' | 'timeout';

export type AcpProbeResult =
  | {
      ok: true;
      target: AcpSpawnTarget;
      protocolVersion: number;
      loadSession: boolean;
      agent?: string;
      authMethods: AcpAuthMethod[];
    }
  | { ok: false; target: AcpSpawnTarget; kind: AcpProbeFailure; detail: string };

/**
 * Strip C0/C1 control characters out of a program's own output before it
 * reaches this terminal. Same hazard `display()` guards on the wire: the daemon
 * prints consent screens here, and stderr carrying `ESC[2J ESC[H` can clear the
 * screen and redraw one. Newline and tab survive; nothing else does.
 */
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control && ch !== '\n' && ch !== '\t' ? ' ' : ch;
  }
  return out;
}

/**
 * `sanitize` for anything printed as one field of a line — a command, a name,
 * an error. A newline in a value the report lays out in columns is a value
 * that can forge a second line of our own output.
 */
function sanitizeInline(text: string): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Node's spawn errors already end in their own code; appending it again
    // would read as two separate findings.
    const code = (err as NodeJS.ErrnoException).code;
    return sanitizeInline(code && !err.message.includes(code) ? `${err.message} (${code})` : err.message);
  }
  return 'unknown error';
}

function readAuthMethods(methodsAdvertised: AuthMethod[] | undefined): AcpAuthMethod[] {
  if (!methodsAdvertised) return [];
  // Everything here is rendered into this terminal, and `terminalArgs` is
  // rendered as a command someone may paste. It is the agent's own text, but
  // the agent is a program the report is about, not an author it trusts.
  return methodsAdvertised.map((method) => ({
    id: sanitizeInline(method.id),
    name: sanitizeInline(method.name),
    ...(typeof method.description === 'string' ? { description: sanitizeInline(method.description) } : {}),
    ...('type' in method && method.type === 'terminal' && method.args
      ? { terminalArgs: method.args.map(sanitizeInline) }
      : {}),
  }));
}

function agentLabel(init: InitializeResponse): string | undefined {
  const info = init.agentInfo;
  if (!info) return undefined;
  return sanitizeInline(`${info.name} ${info.version}`);
}

/**
 * Start the configured agent, ask it one question, and kill it.
 *
 * Never throws and never outlives its deadline. The child is terminated by
 * process GROUP on the way out — the ACP adapter spawns a model process of its
 * own, and killing only the leader leaves that orphaned.
 */
export async function probeAcpRuntime(
  target: AcpSpawnTarget,
  options: { deadlineMs?: number; sink?: LogSink } = {},
): Promise<AcpProbeResult> {
  const log = createLogger('daemon.acp.probe', { sink: options.sink });
  const deadlineMs = options.deadlineMs ?? ACP_PROBE_DEADLINE_MS;
  const fail = (kind: AcpProbeFailure, detail: string): AcpProbeResult => ({ ok: false, target, kind, detail });

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(target.command, target.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      cwd: target.cwd,
    });
  } catch (err) {
    // Node reports a missing binary asynchronously, so this catches only the
    // arguments-are-impossible class — an unusable cwd, mostly.
    log.debug('spawning the agent threw synchronously', { err, data: { command: target.command } });
    return fail('spawn', describeError(err));
  }

  let stderrChars = 0;
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrChars >= MAX_STDERR_CHARS) return;
    const text = chunk.toString();
    stderrChars += text.length;
    stderr.push(text);
  });

  const stderrTail = (): string => {
    const lines = stderr.join('').split('\n').map(sanitizeInline).filter(Boolean);
    return lines.slice(-STDERR_TAIL_LINES).join(' / ');
  };

  // A killed child can fault its own pipes — EPIPE on stdin, a reset stdout.
  // An unhandled stream 'error' becomes an uncaughtException, and the daemon
  // running this preflight exits on those: the cleanup would take down the
  // process before it could print what the probe found.
  for (const [name, pipe] of [
    ['stdin', child.stdin],
    ['stdout', child.stdout],
    ['stderr', child.stderr],
  ] as const) {
    pipe.on('error', (err) => log.debug('agent stdio faulted during the probe', { err, data: { stream: name } }));
  }

  // Resolves, never rejects: the child dying is a result, not an exception.
  const childGone = new Promise<AcpProbeResult>((resolve) => {
    child.once('error', (err) => resolve(fail('spawn', describeError(err))));
    child.once('exit', (code, signal) => {
      const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
      const tail = stderrTail();
      resolve(fail('exit', tail ? `${how}: ${tail}` : how));
    });
  });

  let deadlineTimer: NodeJS.Timeout | undefined;
  const expired = new Promise<AcpProbeResult>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve(fail('timeout', `no answer to ACP initialize within ${Math.round(deadlineMs / 1000)}s`)),
      deadlineMs,
    );
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = client({ name: 'agentport-doctor' }).connect(stream);

  // Built so it CANNOT reject: it is raced, and a rejection settled after the
  // race is a floating rejection — which both daemon CLIs turn into an
  // immediate process exit.
  const attempt: Promise<AcpProbeResult> = connection.agent
    .request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'agentport-doctor', version: '1' },
      clientCapabilities: {
        // The probe lends the agent nothing: no filesystem, no terminal, no
        // elicitation. It asks one question and dies.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // NOT a promise to run anything. ACP gates which auth methods an agent
        // may LIST on this flag — "determines which authentication method types
        // the agent may include in its InitializeResponse" — and listing them
        // is the entire reason to ask. claude-agent-acp returns an empty
        // `authMethods` without it, so a doctor that did not declare it would
        // print an auth section structurally incapable of ever saying
        // anything. The commands are rendered for the person reading; this
        // process performs no authentication (see the header).
        auth: { terminal: true },
      },
    })
    .then(
      (init): AcpProbeResult => ({
        ok: true,
        target,
        protocolVersion: init.protocolVersion,
        loadSession: init.agentCapabilities?.loadSession === true,
        agent: agentLabel(init),
        authMethods: readAuthMethods(init.authMethods),
      }),
    )
    .catch((err: unknown): AcpProbeResult => {
      log.debug('ACP initialize did not answer', { err, data: { command: target.command } });
      return fail('initialize', describeError(err));
    });

  try {
    const outcome = await Promise.race([attempt, childGone, expired]);
    if (outcome.ok || outcome.kind !== 'initialize') return outcome;

    // A dead child takes the connection down with it, so a rejected initialize
    // is usually a symptom. Give the process events a bounded moment to name
    // the real cause rather than blaming the protocol for a program that never
    // started.
    let settleTimer: NodeJS.Timeout | undefined;
    const settle = new Promise<undefined>((resolve) => {
      settleTimer = setTimeout(() => resolve(undefined), CHILD_SETTLE_MS);
    });
    const settled = await Promise.race([childGone, settle]);
    clearTimeout(settleTimer);
    return settled ?? outcome;
  } finally {
    clearTimeout(deadlineTimer);
    try {
      connection.close(new Error('AgentPort runtime probe finished'));
    } catch (err) {
      // Closing a connection whose transport already died can throw. The
      // finding is decided by now and must not be replaced by the cleanup's
      // own failure — this function's contract is that it never throws.
      log.debug('closing the probe connection failed', { err });
    } finally {
      // Always, on every path. An orphaned ACP adapter holds a model process
      // and a terminal nobody is reading.
      try {
        await terminateProcessTree(child);
      } catch (err) {
        // Same reason, louder: a process we could not reap is a real problem,
        // it just is not the answer to the question that was asked.
        log.warn('could not terminate the probed agent process', { err, data: { pid: child.pid } });
      }
    }
  }
}

/**
 * The probe's finding, as terminal lines. One implementation, because a
 * remediation that differs between `agentport doctor` and the daemon's own
 * preflight is two chances to be wrong about the same failure.
 */
export function describeAcpProbe(result: AcpProbeResult, runtimeName: string): string[] {
  const commandLine = acpCommandLine(result.target);
  const lines: string[] = [''];

  if (result.ok) {
    lines.push(`  runtime      ${runtimeName} — an ACP agent over stdio`);
    lines.push(`  command      ${commandLine}`);
    lines.push(`  cwd          ${result.target.cwd}`);
    if (result.agent) lines.push(`  agent        ${result.agent}`);
    lines.push(`  ACP version  ${result.protocolVersion}`);
    lines.push(
      `  loadSession  ${result.loadSession ? 'yes — history replays from the agent’s own store' : 'no — a reload replays the daemon’s observed transcript instead'}`,
    );
    lines.push('');
    lines.push('  The agent starts and speaks ACP.');
    lines.push('');
    lines.push('  That is not proof it is logged in: this probe never runs a model turn, and');
    lines.push('  Claude Code reports a missing login only when one does.');
    if (result.authMethods.length === 0) {
      lines.push('  The agent advertised no authentication methods — it either needs none or');
      lines.push('  authenticates outside ACP.');
    } else {
      lines.push('  The agent offers these ways to log in:');
      lines.push('');
      for (const method of result.authMethods) {
        lines.push(`    ${method.name}${method.description ? ` — ${method.description.trim()}` : ''}`);
        if (method.terminalArgs) lines.push(`      ${commandLine} ${method.terminalArgs.join(' ')}`);
      }
    }
    lines.push('');
    lines.push(`  It will work in ${result.target.cwd} — the project a site's prompts land in,`);
    lines.push('  and where its own file tools start. AGENTPORT_AGENT_CWD points it elsewhere.');
    lines.push('');
    return lines;
  }

  lines.push(
    result.kind === 'spawn' ? '  The agent runtime cannot be started.'
    : result.kind === 'exit' ? '  The agent runtime exited before answering ACP initialize.'
    : result.kind === 'timeout' ? '  The agent runtime started but never answered ACP initialize.'
    : '  The agent runtime refused ACP initialize.',
  );
  lines.push('');
  lines.push(`    runtime  ${runtimeName}`);
  lines.push(`    command  ${commandLine}`);
  lines.push(`    cwd      ${result.target.cwd}`);
  lines.push(`    error    ${result.detail}`);
  lines.push('');

  if (result.kind === 'timeout') {
    lines.push('  A program that reads stdin and says nothing looks exactly like this. The');
    lines.push('  arguments are what put an agent INTO ACP mode — `goose acp`, not `goose`.');
    lines.push('');
  }

  if (result.target.source === 'env') {
    lines.push('  AGENTPORT_ACP_COMMAND and AGENTPORT_ACP_ARGS name that program and its');
    lines.push('  arguments. Fix the pair, or unset both to fall back to the default:');
    lines.push('');
    lines.push(`    ${acpCommandLine(DEFAULT_ACP_COMMAND)}`);
  } else {
    lines.push('  That is the default runtime: Claude Code, driven over ACP and fetched by');
    lines.push('  npx. It needs Node 20+ with npx on PATH, and a Claude that is logged in:');
    lines.push('');
    lines.push('    npx --version                        npx is what fetches the agent');
    lines.push('    npm install -g @anthropic-ai/claude-code');
    lines.push('    claude          # then /login        the agent runs as you, with your login');
    lines.push('');
    lines.push('  Or point AGENTPORT_ACP_COMMAND and AGENTPORT_ACP_ARGS at a different ACP');
    lines.push('  agent — goose, codex, gemini, one you wrote.');
  }

  lines.push('');
  lines.push('  Until this passes, pairing still succeeds and the first prompt from a');
  lines.push('  website fails — in the browser, where nobody can fix it.');
  lines.push('');
  return lines;
}
