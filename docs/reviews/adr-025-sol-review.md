# ADR-025 independent review synthesis

- **Reviewed commit:** `2cd3a2c1dc7ad911d56d128b72288bd0290c3482`
- **Date:** 2026-08-08
- **Reviewers:** three independent `gpt-5.6-sol` workers at high reasoning
  effort, read-only
- **Scopes:** API misuse/package boundary; custody/security architecture;
  acceptance evidence/release feasibility
- **Outcome:** changes requested; accepted findings integrated into ADR-025

## Why three reviews

ADR-025 deliberately contains two different controls. Package design can make
the wrong integration difficult to write, while protocol design can limit an
attachment even when application code is hostile. Asking one review to judge
both makes it too easy for a packaging improvement to be credited as security,
or for an impossible custody claim to erase a useful misuse guardrail.

The third review examined only evidence. Its job was to reject checks that
could pass without seeing the claimed failure and to test the proposed
lockstep migration against the release process that would carry it.

## Consensus findings

### 1. Renaming `AgentWallet` would preserve the footgun

`AgentWallet` (`packages/client/src/wallet.ts#AgentWallet`) combines root
authentication, pairing, certificate issuance, directory/revocation control,
delegated and code-flow attachment opening, concrete sessions, sealing, and
resume. `connect.js` needs attachment transport and none of the root-control
operations.

Moving that class intact to a package called wallet core would improve the
warning label while continuing to bundle the dangerous shape into page code.
The accepted correction is three layers: public app contracts,
attachment-only transport, and wallet control. Wallet and attachment cores
remain workspace-private until their own publication contract exists.

### 2. Same-origin modules are not custody isolation

The first ADR draft allowed the local demo to separate site and wallet by
module or origin. Modules on one origin share storage and call access; they
prove organization, not isolation. A custody demonstration needs a separate
origin, extension context, daemon surface, or other independently protected
signer. A same-origin fixture may remain only as explicitly unsafe protocol
evidence with no persistent root key.

### 3. Direct-owner removal limits attachments and cannot contain a root

Removing the relay and daemon branches that accept
`client === cert.user` makes owner authentication insufficient for website
attachment opening. That is a valuable least-authority rule.

It is not custody proof. An exportable root holder can sign a fresh delegation
or its replacement to an attacker-chosen attachment and controller. The
revised ADR requires a positive test demonstrating that residual root power so
the direct-owner refusal cannot be misreported as containment of root
compromise.

### 4. Controller authority does not require a second relay channel initially

The first draft left the controller topology undecided while treating it as a
normative protocol boundary. The smallest coherent design keeps the existing
sealed attachment channel and adds a controller key, rights, and signed
approval/answer proofs inside ciphertext. The daemon can then distinguish
attachment possession from authority to answer as the user while the relay
remains blind.

A second sealed controller channel remains useful for cross-device or
attachment-blind control, but adds association, reconnect, resume, loss, and
multi-controller state. It is neither required for the first separation nor
sufficient against root compromise.

### 5. Resume currently lets a malicious relay replace the E2EE endpoint

This was the blocking finding. The relay sees the bearer resume token in
lifecycle metadata. `AgentDaemon#onSessionResume`
(`packages/daemon/src/daemon.ts#onSessionResume`) verifies the new EPK against
the new relay-stamped client key, never compares that key to the stored
attachment identity, and then overwrites `session.clientKey`.

An in-scope malicious relay can force detach, reuse the observed token with
its own Ed25519/X25519 keys, and become the application-side plaintext
endpoint. Retained runtime-own and elicitation policy transfers with the
session. Existing theft tests do not cover a relay that both sees the token and
can manufacture detach.

The accepted correction makes the Ed25519 attachment identity stable across
the logical attachment, keeps X25519 rekeys fresh, and requires the daemon to
match the stored identity on resume. This repair precedes controller work.

### 6. Passkey wrapping is not non-exportable signing

Using WebAuthn to unwrap a raw Ed25519 key protects storage while locked. Once
the raw key exists in JavaScript, wallet-origin compromise can export it.
WebAuthn also signs authenticator/client-data structures rather than arbitrary
AgentPort canonical bodies.

The revised ADR distinguishes at-rest wrapping from a protocol-verifiable
WebAuthn proof or WebAuthn-authorized wallet credential. A remote signer must
enforce operation-specific policy rather than act as a generic signing oracle.

### 7. The release smoke exercised checkout source, not the npm artifact

The committed workflow saved a tarball but ran `scripts/remote-check.ts`, which
imported the daemon directly from the checkout. A new relay and old npm package
could therefore produce a green smoke. It also allowed hosted deployment when
the CLI version's tag already existed, even if CLI/daemon/protocol source had
changed.

The follow-up correction bundles one remote-check implementation into the CLI
artifact (`packages/cli/build.ts#buildRemoteCheck`), extracts that saved
tarball after deployment, and runs its copy. The workflow rejects
CLI/daemon/protocol changes under an already-tagged CLI version and runs the
separately excluded browser, Worker, wallet, extension, and example typechecks.

## Evidence corrections accepted

- Direct-owner refusal needs independent real-relay and lying-relay-to-daemon
  checks; either edge alone is insufficient.
- A forged page response is dropped and logged but must not settle the trusted
  request. Settlement comes from a valid controller/local response, deadline,
  abort, controller loss, or session close.
- The extension control path needs a real-Chrome test with a real local relay,
  daemon, scripted runtime, hostile page, and extension-origin decision UI.
- Export removal needs a non-empty structural type assertion plus a diagnostic-
  specific negative fixture. A generic "compilation failed" wrapper can pass
  for module-resolution failure.
- Bundle authority is checked from real esbuild metafiles, not by searching a
  minified string.
- The clean-browser stranger walk and visual honesty remain human obligations;
  source checks cannot prove understanding.
- Every request/response path has a local deadline and an outer harness
  timeout. Each new check is sabotaged once and its intended failure read.

## Worker evidence and parent acceptance

All workers inspected the governing `AGENTS.md`, north star, ADRs, production
routing symbols, and the files in their assigned scopes. They returned durable
reports with inspected files, commands, uncertainties, and residual risks.
They made no repository edits and contacted no external systems.

The evidence worker ran the harness, site, wallet, extension, and example
typechecks successfully. Its read-only sandbox prevented `tsx` from creating
the local IPC socket required to start wire/E2E checks; that was reported as
environment-unavailable, never as a pass. The parent independently confirmed
the resume and release-workflow findings in source, integrated the decisions,
and reran the repository gates after editing.

## Residual gaps

- Root key compromise remains terminal until a selected non-exportable or
  policy-enforcing remote signer exists.
- Controller-key generation, rotation, persistence, and recovery remain an
  implementation design item.
- A future cross-device controller may justify a distinct relay role/channel.
- Load-unpacked extension distribution cannot be atomic with Cloudflare and
  npm; old peers must fail visibly without a compatibility downgrade.
- No automated check can prove where an exportable key was held, that
  third-party wallet UI was honest, or that a human understood consent.
