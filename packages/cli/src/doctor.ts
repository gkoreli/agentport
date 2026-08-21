/**
 * `agentport doctor` — does the agent this machine is configured to run
 * actually start?
 *
 * The default runtime carries a prerequisite nothing declared: `agentport`
 * drives Claude Code over ACP, which means a program has to be fetchable,
 * runnable, and logged in. Without this command the first evidence a stranger
 * got was a session that failed in their browser, minutes after pairing
 * succeeded and the terminal had stopped saying anything.
 *
 * The probe itself lives in `packages/daemon/src/acp-preflight.ts` because the
 * daemon runs it too, before it dials the relay. This file is the subcommand
 * around it: pick the runtime, print the finding, choose an exit code. It adds
 * no second opinion about what a healthy runtime is.
 *
 * It reports authentication; it never performs it. ACP `authenticate` is not
 * implemented here or anywhere in this repo — a preflight that logged you into
 * your model provider would be holding a credential AgentPort has no business
 * touching. What it prints is the login command the agent itself advertises.
 */

import {
  ACP_PROBE_DEADLINE_MS,
  acpCommandLine,
  describeAcpProbe,
  isAcpRuntime,
  probeAcpRuntime,
  resolveAcpSpawn,
} from '@agentport/daemon/acp-preflight';

export async function doctor(): Promise<number> {
  // The same default the daemon applies, so doctor never reports on a runtime
  // other than the one `agentport` would start.
  const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'demo-writer';

  if (!isAcpRuntime(runtimeName)) {
    console.error('');
    console.error(`  AGENTPORT_RUNTIME is "${runtimeName}", which spawns no agent process.`);
    console.error('');
    console.error('  doctor checks ACP-backed runtimes — the ones that start a real agent and');
    console.error('  can therefore fail to. Set one and run this again:');
    console.error('');
    console.error('    AGENTPORT_RUNTIME=claude-code agentport doctor   the default');
    console.error('    AGENTPORT_RUNTIME=acp agentport doctor           any other ACP agent');
    console.error('');
    return 1;
  }

  const target = resolveAcpSpawn(process.env);
  if (typeof target === 'string') {
    // Half a pair. The resolver's own message names both variables; repeating
    // it here in different words would be a second thing to keep true.
    console.error('');
    console.error(`  ${target}`);
    console.error('');
    return 1;
  }

  console.log('');
  console.log(`  Starting ${acpCommandLine(target)}`);
  console.log(
    `  Giving it up to ${Math.round(ACP_PROBE_DEADLINE_MS / 1000)}s to answer — a first run fetches the agent before it can.`,
  );

  const result = await probeAcpRuntime(target);
  for (const line of describeAcpProbe(result, runtimeName)) {
    if (result.ok) console.log(line);
    else console.error(line);
  }
  return result.ok ? 0 : 1;
}
