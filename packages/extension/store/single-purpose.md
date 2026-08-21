# Single purpose, and why each permission exists

Source-controlled so it is reviewed like code and stays true as the code
moves. This file is the text submitted in the Chrome Web Store's privacy
practices tab; `listing.md` beside it is the listing copy; the privacy policy
the listing links is `site/public/privacy.html`, served at
`https://agentport.gogakoreli.workers.dev/privacy`.

## Single purpose

AgentPort connects websites to the user's own AI agent — one the user already
runs on their own machine or server — for one session at a time, with the
user's consent per site and per sensitive action. The extension is the user's
wallet: it holds the user's identity key, shows every consent decision in
extension-owned windows, and relays messages between the page and the user's
agent over an end-to-end encrypted channel. It does not provide, host, or sell
an AI model, and it does nothing on any website the user has not enabled it
on.

## Permissions

### `host_permissions: http://*/*, https://*/*` with `scripting`

AgentPort works on whatever site the user chooses to bring their agent to —
the set is the user's, not ours, so it cannot be enumerated in the manifest.
Breadth is REQUESTED broadly and EXERCISED narrowly:

- Page-visible code (the `navigator.agent` provider and the panel) is
  registered per origin with `chrome.scripting.registerContentScripts`, only
  for origins the user explicitly enabled from the toolbar popup. On every
  other site the extension injects nothing, renders nothing, answers nothing,
  and is not detectable by the page.
- The provider must exist before the page's own scripts run (sites feature-
  detect it, and the WebMCP shim must be installed first to see the page's
  tool registrations). Only a `document_start` registration guarantees that
  ordering, which is why `activeTab` alone cannot substitute: an `activeTab`
  grant begins at the user's gesture, after the page has already loaded and
  its scripts have already made the checks that matter.
- The one static content script runs in the isolated world, where pages
  cannot observe it. It exists so that a tab navigating away from an enabled
  site still ends the agent's attachment, and so pairing links from the
  user's own configured AgentPort host work before any site is enabled.

### `activeTab`

Read the current tab's origin when the user opens the popup, so the popup can
offer "enable AgentPort on this site" for the site the user is looking at,
and reload that tab when they do. No other tab access is requested; the
extension has no `tabs` permission and never reads browsing history.

### `storage`

The user's identity key (encrypted with a user passphrase when one is set —
see the privacy policy for the exact storage keys and their lifetimes), the
list of origins the user enabled, the user's paired-agent directory, the
relay URL, and short-lived session-resume records that expire with the
browser session.

### `alarms`

A periodic wake for the service worker only while an agent session is live,
so an active session survives Chrome's worker eviction. The alarm is cleared
when the last session ends; an idle install schedules nothing.

## What the extension deliberately does not request

No `tabs`, no `history`, no `webRequest`, no `cookies`, no
`declarativeNetRequest`, no `nativeMessaging`, no remote code. The extension
never fetches or executes code from the network; every byte it runs ships in
the package.
