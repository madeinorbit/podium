# Claude subscription OAuth on the Agent SDK

**Current policy, 2026-08-28 11:44 CEST.** Operator-authorized for POD-1761.
Supersedes earlier normative statements that Claude subscription OAuth is
ToS-prohibited on the Agent SDK, or that Claude headless is terminal-only.

Historical audits, evidence reports, `results.tsv` rows, and source comments
that record the old stance stay historical. Do not rewrite them as if this
policy had always been true.

## Stance

1. **The persistent Claude Agent SDK path may use the managed subscription
   credential.** That includes the native `claudeAiOauth` blob, a
   `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` login, and the
   `managed:claude-oauth` account. API-key / Bedrock / Vertex remain valid
   embedded principals; they are no longer the only ones.
2. **Claude headless is a first-class, high-priority driver** (`claude-sdk`),
   not a leftover of the interactive TUI. Treat it as a column the epic must
   get right, the same way Codex app-server and Grok ACP are treated.
3. **PTY (`claude-pty`) is the permanent fallback**, not the exclusive
   subscription-preserving path. Use it when the SDK path is unavailable,
   refused, logged out, or when a human asked for a visible
   terminal. Do not delete the terminal family for Claude.
4. **The SDK is an explicit driver choice, without a separate acknowledgement
   gate.** Do not silently flip every Claude session to the SDK. An explicit
   per-spawn `claude-sdk` preference is sufficient; ordinary Claude sessions
   stay on the PTY path.
5. **Third-party reuse is still barred.** Putting an Anthropic *subscription*
   token into opencode or any other third-party tool remains ToS-prohibited.
   This policy covers Claude Code's own Agent SDK / `claude -p` surface, not
   exporting the subscription into someone else's product.

## Credential-safety boundary (unchanged)

Authorization to *use* the subscription on the SDK path does not authorize
minting, rotating, or replaying it. The standing brief still holds:

- Do not create or fabricate a credential.
- Do not rotate the operator's live login (interactive OAuth mid-release does
  exactly that).
- Do not present a superseded refresh token from a rig home — that can revoke
  the whole family and log the operator out.
- Do not set `PODIUM_RUNTIME_DRIVER` to fake a binding.
- Copying an *existing*, unexpired credential into an isolated agent home is
  allowed; then confirm the *product* sees it (`loginRequired` / the harness's
  own logged-in readout), not only that the file is on disk.
- Fail loud with no credential rather than seed a stale Claude blob.

## Acceptance and testing expectations

For the POD-1761 coordinator and every later agent:

- **In scope.** Claude SDK / headless cells are first-class acceptance work,
  high priority. Do not skip them because an older spec row said "terminal
  only" or "embedded rework is a non-goal."
- **Do not relitigate the ToS bar** for Claude's own SDK. If a drive or
  implementation is blocked, the blocker is a product defect or the
  credential-safety boundary — not "subscription OAuth is prohibited."
- **Preserve history.** Leave `docs/plans/pod-1761-results.tsv`,
  `docs/evidence/**`, and audit-time classifications alone. Append a current
  reading; do not edit an old one to match this policy.
- **Source comments are not policy.**
  `packages/harness/src/manifests/claude-code.ts` now declares subscription
  OAuth for the embedded SDK. If a stale comment elsewhere still describes the
  old exclusion, treat it as implementation drift rather than a policy veto;
  this policy does not turn that drift into a new acceptance result.
- **This documentation lane does not run provider or heavy tests.** Future
  SDK drives still follow the standing brief: pin server, web bundle, *and*
  daemon; take `test:heavy` only for memory-heavy work; never overlap gates;
  never merge main into the epic branch.

Canonical current text: this file. Spec and agent pointers:
`docs/SPEC.md`, `docs/2026-08-07-agent-runtime-architecture.html` §2,
`docs/agents/pod-1761-standing-brief.md`.
