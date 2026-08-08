/**
 * Which ACP agent to spawn, resolved once.
 *
 * `AGENTPORT_ACP_COMMAND` and `AGENTPORT_ACP_ARGS` are the two variables that
 * make the runtime pluggable — NORTH-STAR's "someone swaps in a runtime we
 * have never heard of, and that just works too". They are a PAIR: one names a
 * program, the other names that program's arguments, and arguments for one
 * program are meaningless to another.
 *
 * They used to default independently, in three copies across two CLIs:
 *
 *     command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
 *     args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp').split(' '),
 *
 * So `AGENTPORT_ACP_COMMAND=goose` on its own spawned
 * `goose -y @agentclientprotocol/claude-agent-acp` — goose invoked with Claude
 * Code's npx arguments. It is the obvious half of the pair to set, the docs
 * said "changing two env vars" without saying they are inseparable, and the
 * result fails somewhere far from the cause.
 *
 * So the pair defaults together or not at all, and a half-configured
 * environment is refused with both names in the message rather than guessed
 * at. An agent that genuinely takes no arguments says so explicitly with
 * `AGENTPORT_ACP_ARGS=`, which is unambiguous in a way that "unset" is not.
 */

/** The default pair: Claude Code over ACP, fetched by npx. */
const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = '-y @agentclientprotocol/claude-agent-acp';

export interface AcpCommand {
  command: string;
  args: string[];
}

/**
 * Resolves the pair, or explains what is missing. Returns a string instead of
 * throwing so each CLI can report it the way it reports everything else.
 */
export function resolveAcpCommand(env: Record<string, string | undefined>): AcpCommand | string {
  const command = env['AGENTPORT_ACP_COMMAND'];
  const args = env['AGENTPORT_ACP_ARGS'];

  if (command === undefined && args === undefined) {
    return { command: DEFAULT_COMMAND, args: DEFAULT_ARGS.split(' ').filter(Boolean) };
  }
  if (command === undefined) {
    return 'AGENTPORT_ACP_ARGS is set but AGENTPORT_ACP_COMMAND is not — they are a pair, and arguments alone name no agent.';
  }
  if (args === undefined) {
    return (
      `AGENTPORT_ACP_COMMAND is set to "${command}" but AGENTPORT_ACP_ARGS is not. ` +
      'They are a pair: without it you would get this command with Claude Code\'s arguments. ' +
      'Set AGENTPORT_ACP_ARGS too — empty (AGENTPORT_ACP_ARGS=) if the agent takes none.'
    );
  }
  return { command, args: args.split(' ').filter(Boolean) };
}
