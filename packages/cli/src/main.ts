/**
 * The published entry point. Users run one command; whether an always-on
 * service already owns the agent is an implementation detail handled here.
 *
 *   npx @gkoreli/agentport               start the agent or pair the running one
 *   npx @gkoreli/agentport connect CODE  approve a drop-in connect code from a site
 *
 * This wrapper exists so a bare VPS needs no repo checkout: it sets the
 * defaults a fresh machine wants — the deployed relay, the Claude Code
 * runtime, an agent named after the host — and then hands over to the same
 * daemon/connect code the repo runs. Every default yields to an existing
 * AGENTPORT_* env var, so nothing here fights explicit configuration.
 */

import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';

declare const __AGENTPORT_CLI_VERSION__: string;
const CLI_VERSION = typeof __AGENTPORT_CLI_VERSION__ === 'string' ? __AGENTPORT_CLI_VERSION__ : 'development';

const DEPLOYED_RELAY = 'wss://agentport.gogakoreli.workers.dev/relay';

function defaults(): void {
  process.env.AGENTPORT_RELAY ??= DEPLOYED_RELAY;
  process.env.AGENTPORT_WALLET ??= 'https://agentport.gogakoreli.workers.dev/pair';
  process.env.AGENTPORT_RUNTIME ??= 'claude-code';
  process.env.AGENTPORT_NAME ??= `Agent on ${hostname()}`;
  process.env.AGENTPORT_LOCATION ??= hostname();
}

const command = process.argv[2];

if (command === 'connect') {
  // connect-cli reads the code from argv[2]; drop the subcommand so it does.
  process.argv.splice(2, 1);
  defaults();
  await import('@agentport/daemon/connect-cli');
} else if (command === undefined) {
  defaults();
  const serviceIsActive = process.platform === 'linux' &&
    spawnSync('systemctl', ['is-active', '--quiet', 'agentport.service']).status === 0;
  if (serviceIsActive) await import('./pair.js');
  else {
    process.env.AGENTPORT_PAIR_ON_START = '1';
    await import('@agentport/daemon/cli');
  }
} else if (command === 'daemon') {
  // Internal systemd entry point. Kept out of user-facing help.
  defaults();
  await import('@agentport/daemon/cli');
} else if (command === 'doctor') {
  // defaults() first, so doctor probes the runtime `agentport` would start
  // rather than the daemon's own repo-development default.
  defaults();
  process.exit(await (await import('./doctor.js')).doctor());
} else if (command === 'status') {
  process.exit((await import('./revoke.js')).status());
} else if (command === 'revoke') {
  const origin = process.argv[3];
  if (!origin) {
    console.error('  usage: agentport revoke <origin>   e.g. agentport revoke https://example.com');
    process.exit(1);
  }
  process.exit((await import('./revoke.js')).revoke(origin));
} else if (command === 'unpair') {
  process.exit(await (await import('./revoke.js')).unpair());
} else if (command === '--version' || command === '-v') {
  console.log(CLI_VERSION);
} else {
  console.log(`AgentPort ${CLI_VERSION}

  npx @gkoreli/agentport            start your agent, or pair the one already running
  npx @gkoreli/agentport doctor     can this machine actually run the agent?
  npx @gkoreli/agentport status     who owns this agent, and what you have cut off
  npx @gkoreli/agentport revoke URL stop an origin using this agent
  npx @gkoreli/agentport unpair     this agent belongs to nobody until you pair it again`);
  process.exit(command === 'help' || command === '--help' ? 0 : 1);
}
