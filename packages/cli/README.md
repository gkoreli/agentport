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

## What it needs first

The default runtime is **Claude Code, driven over ACP**. `npx` fetches that
adapter and the Claude CLI it bundles, so there is nothing to install by hand
— but the CLI has to be **logged in as you**, and pairing does not check.
An unauthenticated machine pairs perfectly and then fails on the first prompt,
in a browser tab, where nobody can fix it.

So check the machine before a website is waiting on it:

```bash
npx @gkoreli/agentport doctor
```

That starts the agent this machine is configured to run, speaks one ACP
`initialize` to it, and prints what came back: the command, the ACP version,
whether history can replay, and the ways the agent says you can log in. Exit 0
means the agent runs. `agentport` runs the same probe itself before it prints
a pairing code, so a runtime that cannot start fails in your terminal instead
of in someone's tab.

Being exact about what green means, because it is less than it looks: doctor
proves the agent **starts and speaks ACP**. It does not prove it is logged in.
Claude Code reports a missing login only once a prompt runs a model turn, and
running one on every check would spend a turn on your subscription to learn
it. Doctor reports authentication; it never performs it.

To check the login itself, or fix it:

```bash
npx -y @agentclientprotocol/claude-agent-acp --cli auth status   # {"loggedIn": true, …}
npx -y @agentclientprotocol/claude-agent-acp --cli auth login --claudeai
```

Those are the adapter's own passthrough to the Claude CLI it ships — the same
login Claude Code uses, so `claude` then `/login` gets you there too if you
already have it installed. Doctor prints whichever login commands your agent
advertises, which is the version that stays true if you swap the agent out.

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
agentport doctor          # can this machine actually run the agent?
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
| `AGENTPORT_ACP_COMMAND` / `AGENTPORT_ACP_ARGS` | the ACP agent to spawn — goose, codex, gemini, whatever you run. A pair: set one and the other is refused rather than guessed at |
| `AGENTPORT_AGENT_CWD` | the directory the agent starts in — default, wherever you ran this. It is the project a site's prompts land in, and where the agent's own file tools begin; point it at the work you want reachable, not at your home directory |
| `AGENTPORT_NAME` / `AGENTPORT_LOCATION` | how this agent is labelled in your own wallet |

## Status

Early, and honest about it: this has not had an independent security audit.
The threat model, what the relay can and cannot see, and the known gaps are
written down rather than implied —
see [the architecture records](https://github.com/gkoreli/agentport/blob/main/docs/ADR.md).

Source, issues and the full design:
**https://github.com/gkoreli/agentport**

Apache-2.0.
