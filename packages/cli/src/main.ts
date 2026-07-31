/**
 * The published entry point: `npx @agentport/cli` and everything just works.
 *
 *   npx agentport               run the agent daemon (prints a pairing code)
 *   npx agentport connect CODE  approve a drop-in connect code from a site
 *   npx agentport service       install the always-on systemd unit (Linux)
 *
 * This wrapper exists so a bare VPS needs no repo checkout: it sets the
 * defaults a fresh machine wants — the deployed relay, the Claude Code
 * runtime, an agent named after the host — and then hands over to the same
 * daemon/connect code the repo runs. Every default yields to an existing
 * AGENTPORT_* env var, so nothing here fights explicit configuration.
 */

import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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
} else if (command === 'service') {
  defaults();
  const unit = `[Unit]
Description=AgentPort agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${process.env.SUDO_USER ?? process.env.USER ?? 'root'}
ExecStart=/usr/bin/env npx -y @agentport/cli daemon
Environment=AGENTPORT_RELAY=${process.env.AGENTPORT_RELAY}
Environment=AGENTPORT_RUNTIME=${process.env.AGENTPORT_RUNTIME}
Environment=AGENTPORT_NAME=${process.env.AGENTPORT_NAME}
Environment=AGENTPORT_LOCATION=${process.env.AGENTPORT_LOCATION}
UMask=0077
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
  if (process.platform !== 'linux') {
    console.error('service install is Linux/systemd only; run `npx agentport` directly instead');
    process.exit(1);
  }
  try {
    writeFileSync('/etc/systemd/system/agentport.service', unit);
  } catch {
    console.error('could not write /etc/systemd/system/agentport.service — run with sudo');
    process.exit(1);
  }
  for (const args of [['daemon-reload'], ['enable', '--now', 'agentport']]) {
    const result = spawnSync('systemctl', args, { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log('agentport is now always-on. Watch it with: journalctl -u agentport -f');
} else if (command === undefined || command === 'daemon') {
  defaults();
  await import('@agentport/daemon/cli');
} else {
  console.log('usage: agentport [daemon | connect <CODE> | service]');
  process.exit(command === 'help' || command === '--help' ? 0 : 1);
}
