# Chrome Web Store listing

The copy and asset specifications for the store submission. Submission itself
is an owner action (developer account, one-time fee, review). What code must
already be true before submitting is tracked in the repo, not here — this
file is only what the store form asks for.

## Title

AgentPort

## Summary (132 chars max)

Bring your own AI agent to any website. Your agent, your machine, your keys —
sites borrow it for a session and learn nothing else.

## Category

Productivity › Tools

## Description

Every app ships its own chatbot and pays for its own inference. AgentPort
inverts that: you run ONE agent — on your laptop or your server, on your
subscription, with your files and your memory — and bring it to websites you
choose.

WHAT IT DOES

- Pair the extension with the agent you already run (Claude Code today;
  any ACP-speaking agent: goose, codex, gemini, or one you wrote).
- On sites you enable, the site can lend your agent a few tools for one
  session — with your approval, shown in a trusted extension window the page
  cannot draw over.
- On sites that declare nothing, AgentPort can lend your agent a careful set
  of generic page tools (read, find, fill, click) — every risky action asks
  you first, and the approval names exactly what will be clicked.
- Sessions are end-to-end encrypted between your browser and your agent. The
  relay in between routes ciphertext and stores nothing.

WHAT IT NEVER DOES

- It does nothing on sites you have not enabled — no injected code, no
  detectable presence.
- It never sees or sells a model. There is no account, no telemetry, no
  inference bill — your agent runs on whatever you already pay for.
- Your conversation lives with your agent, on your machine. Not with us.

Open protocol, open source. Self-hosting the relay is one environment
variable.

## Privacy policy URL

https://agentport.gogakoreli.workers.dev/privacy

## Asset specifications

Store requirements, with content notes so the captures say something true:

- **Icon 128×128** — exists (`static/icon128.png`).
- **Screenshots, 1280×800, 3–5 of:**
  1. The popup with a paired agent and one enabled site — the "your agent,
     where you allowed it" frame.
  2. A consent window for a site-lent tool set (the connect screen with the
     gated-tool list) — the "you approve what a site may borrow" frame.
  3. A per-call approval naming its exact click target on a real page — the
     harness's best property, shown rather than claimed.
  4. The panel mid-conversation on a site that declared nothing, with the
     plan visible.
  5. The "origins holding your agent" list with the Revoke button — the
     "take it back any time" frame.
- **Small promo tile 440×280** — wordmark + one line: "Bring your own
  agent." No screenshots inside the tile; they are illegible at that size.
- **Marquee 1400×560 (optional)** — defer until the listing is live.

Screenshots must be taken against the deployed demo surfaces or a real
enabled site, never against mocked data: a reviewer who installs and sees a
different UI than the screenshots is a rejection reason.
