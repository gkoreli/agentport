# @gkoreli/agentport

**Bring your own agent to any website.**

```bash
npx @gkoreli/agentport
```

Run that on the machine where your agent lives. It prints a one-time link;
open it, approve, and any site that supports AgentPort can borrow that agent
for the length of a visit.

The site never learns which runtime you use, which model, whose memory, or who
pays for inference. It lends your agent a few tools; your agent stays on your
machine.

## What the command does

- starts a local agent host and dials **out** to a relay over `wss://` — no
  inbound port, nothing listening on your machine;
- prints a pairing link and code;
- waits. Consent happens where your key is: in your browser's wallet or
  extension, or in this terminal if you have neither.

Session content is sealed end to end between the browser and this process, so
the relay carries ciphertext and cannot read your conversation.

## Commands

```bash
agentport                 # start the agent and pair
agentport status          # who owns this agent, and what you have cut off
agentport revoke <origin> # stop a site using this agent
agentport unpair          # the agent belongs to nobody again
agentport connect <CODE>  # claim a code a website is showing you
```

## Configuration

| variable | what it sets |
|---|---|
| `AGENTPORT_RELAY` | which relay to dial (self-host your own and no third party is in the path) |
| `AGENTPORT_IDENTITY` | where the agent's device key lives — default `~/.agentport/agent.json` |
| `AGENTPORT_RUNTIME` | which agent to drive; any ACP-speaking agent works |
| `AGENTPORT_ACP_COMMAND` / `AGENTPORT_ACP_ARGS` | the ACP agent to spawn — goose, codex, gemini, whatever you run |
| `AGENTPORT_NAME` / `AGENTPORT_LOCATION` | how this agent is labelled in your own wallet |

## Status

Early, and honest about it: this has not had an independent security audit.
The threat model, what the relay can and cannot see, and the known gaps are
written down rather than implied —
see [the architecture records](https://github.com/gkoreli/agentport/blob/main/docs/ADR.md).

Source, issues and the full design:
**https://github.com/gkoreli/agentport**

Apache-2.0.
