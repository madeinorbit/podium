# Spec: Claude Login Status Detection

Status: proposed · 2026-08-18

## 1. Decision

Podium determines Claude Code login state by running the verified Claude executable's supported
`auth status` command in the same immutable command environment used to launch Claude. A valid
machine-readable status response is authoritative. File inspection remains only a compatibility
fallback for an older executable that demonstrably does not support the command.

This replaces `.claude/.credentials.json` existence as the normal Claude login probe. On macOS,
Claude Code stores its native login in Keychain, so a missing credential file says nothing about
whether Claude can authenticate.

This spec covers login detection and login identity publication. Credential export and install are
specified separately in [Claude Keychain Credential Transfer](claude-keychain-transfer.md).

## 2. Context

Podium publishes each machine's agent installation and login state through the inventory and fleet
catalog described in [Cross-machine login catalog](../2026-08-04-cross-machine-login-catalog.md).
That catalog drives account display, donor selection, and automatic login propagation.

Today the Claude manifest synchronously reads `.credentials.json`. The current Claude Code CLI uses
the macOS login Keychain instead, while `claude auth status` reports the state the CLI will actually
use. The result is a false `out` state for a working macOS login. That false state also prevents the
machine from becoming a propagation donor and can cause unnecessary propagation attempts toward it.

The executable used for the probe must obey the command-environment rules in
[Harness executable environment](harness-executable-environment.md). Detecting one executable and
launching another is not acceptable.

## 3. Goals

- Report `in` when the resolved Claude executable reports a usable login, including a Keychain login.
- Report `out` only when Claude returns a valid, settled logged-out result.
- Preserve the distinction between logged out and unable to determine state.
- Publish the provider identity returned by Claude when available.
- Keep older, file-backed Claude installations working without guessing a version cutoff.
- Ensure tests can exercise every result without invoking a real provider CLI.

## 4. Non-goals

- Reading the macOS Keychain directly for login detection.
- Proving that a particular model request or network endpoint is currently available.
- Treating environment-only API keys or setup tokens as portable native Claude credentials.
- Changing login propagation policy, donor ownership, or consent behavior.
- Adding continuous per-session or per-prompt auth polling.

## 5. Inventory probe contract

### 5.1 Probe order

Claude login detection moves after executable resolution and identity verification in the inventory
pipeline. For each inventory generation Podium must:

1. Resolve and verify the absolute Claude executable as it does today.
2. Run `<resolved-path> auth status` with that generation's `CommandEnvironment.env`.
3. Parse the completed command result according to section 6.
4. Publish the resulting `HarnessLogin` with the same inventory generation and resolved executable.

The path used for `auth status` must be the path stored in `ResolvedHarnessExecutable`. Podium must
not invoke a bare `claude` name for this probe.

The probe runs once per normal inventory refresh. Session spawn consumes the published inventory; it
does not add another synchronous auth check to the launch path.

### 5.2 Required command result

The existing `ProbeExec` seam returns only stdout and rejects all non-zero exits. Login probing needs
a richer injectable seam that retains:

```ts
interface CommandProbeResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal?: string
  readonly timedOut: boolean
}
```

The implementation may use a separate login-probe executor or generalize `ProbeExec`, but version
and identity probe behavior must remain unchanged. Tests must inject results rather than launch a
real CLI.

The outer timeout is 12 seconds, allowing Claude's own Keychain read timeout to complete while still
bounding inventory refresh. Stdout and stderr are each bounded to 1 MiB. A timeout, signal, or output
limit is an indeterminate result, never evidence of logout.

### 5.3 Manifest declaration

Command-based login detection is declared by the harness manifest rather than hard-coded in generic
inventory code. The declaration supplies the arguments, parses a `CommandProbeResult`, and identifies
the narrow unsupported-command response that permits compatibility fallback.

The synchronous `detectLogin(homeDir)` contract remains the file-backed fallback during migration.
Once all command-capable manifests use the new declaration it may be renamed to make its fallback
role explicit; this spec does not require a repository-wide manifest rewrite.

## 6. Claude status classification

Podium accepts a single JSON object with a boolean `loggedIn` property. Known optional properties
include `email`, `orgId`, `orgName`, `authMethod`, `apiProvider`, and `subscriptionType`. Unknown
properties are ignored.

Classification is normative:

| Command result | Published login state |
| --- | --- |
| Valid JSON with `loggedIn: true` and exit 0 | `in` |
| Valid JSON with `loggedIn: false` and exit 1 | `out` |
| Valid JSON whose flag and documented exit code disagree | `unknown` |
| Timeout, signal, launch failure, or truncated output | `unknown` |
| Malformed JSON or missing/non-boolean `loggedIn` | `unknown` |
| Keychain locked, denied, unavailable, or interaction disallowed | `unknown` |
| Recognized unsupported-command response from an older CLI | File fallback from section 7 |

Podium must not infer `out` from an arbitrary exit code 1. It is the combination of a valid
`loggedIn: false` document and the documented exit that establishes a settled logout.

Only the older-CLI signature may activate file fallback. A general execution failure or Keychain
failure must not fall back, because doing so would recreate the macOS false-logout bug.

## 7. Compatibility fallback

When a resolved Claude executable demonstrably lacks `auth status`, Podium runs the existing
file-backed detector against its credential home. A valid, non-empty credential document reports
`in`; a genuinely missing or empty document reports `out`; unreadable or malformed content reports
`unknown`.

When no Claude executable can be resolved:

- `installed` remains false under the existing inventory contract.
- File-backed platforms may retain their best-effort file state for compatibility.
- Darwin must not turn missing `.credentials.json` into a settled `out`; its Claude login state is
  `unknown` because the authoritative command cannot run.

No version number is used to choose the storage model. Capability detection is the compatibility
boundary.

## 8. Credential home and environment

The status command receives the immutable environment associated with its resolved executable.
Podium must preserve whether `CLAUDE_CONFIG_DIR` was absent. In particular, it must not synthesize
`CLAUDE_CONFIG_DIR=~/.claude` for a default macOS account: current Claude uses an unscoped Keychain
service when the variable is absent and a hashed, scoped service when it is explicitly set.

An explicitly configured `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` is passed through
unchanged. This ensures the status probe and the eventual Claude session select the same Keychain
item.

If Podium later supports an alternate credential home that cannot be represented by the existing
command environment, inventory must publish `unknown` until launch and probe share one explicit
environment. It must not inspect the default user's credentials as a substitute.

## 9. Identity and privacy

For a logged-in result, a non-empty `email` becomes `HarnessLogin.account` and the source for
`LoginIdentity.fingerprint` and `LoginIdentity.email`. If email is absent, Podium may display
`orgName` or the existing neutral `Claude login` label, but it must not invent a stable account
fingerprint from a display name.

The status output is authentication metadata, not a credential bundle. Even so, Podium must not log
raw stdout or stderr. Logs may include only the executable kind, result classification, exit status,
and a redacted error category. Inventory publishes only the fields already allowed by the login
catalog.

The status result can be `in` for a non-native mechanism such as an environment API key. Such a
machine may appear logged in but fail credential export. That is safe: donor export failure is a
non-destructive propagation failure and must not cause Podium to manufacture a native credential.

## 10. Catalog and propagation behavior

- A valid `in` result is eligible for ordinary catalog publication and donor consideration.
- A valid `out` result is eligible for the existing propagation trigger.
- An `unknown` result is neither a donor nor a logged-out target. It must not trigger automatic
  credential installation.
- A later valid probe replaces `unknown` through the normal inventory revision flow.
- The existing server-side ownership, online-machine, backoff, and consent rules are unchanged.

The old file-absence grace is not needed after a valid `loggedIn: false` result because the provider
CLI has already supplied a settled answer. Transient command and Keychain failures become `unknown`
instead of entering an absence timer.

## 11. Failure behavior

Inventory refresh must remain usable when the auth command fails. Probe failure is isolated to
Claude's login state and cannot suppress executable or version inventory.

No probe path may open a browser, display an interactive login, unlock a Keychain, or prompt for a
password. If macOS denies non-interactive Keychain access in the daemon's execution context, Podium
reports `unknown` with a non-secret diagnostic category.

## 12. Verification

Hermetic tests must cover:

- Resolved absolute executable and immutable environment are used for the status command.
- Valid logged-in and logged-out JSON, including documented exit codes.
- Email identity publication and absence of an invented fingerprint.
- Contradictory exit/JSON, malformed output, timeout, signal, and output overflow.
- Keychain-style execution errors classify as `unknown`, never `out` or file fallback.
- A recognized unsupported-command result activates the file detector.
- Older valid, empty, missing, unreadable, and malformed credential files.
- Missing Darwin credential file plus successful status still reports `in`.
- Explicit and absent `CLAUDE_CONFIG_DIR` values are preserved exactly.
- `unknown` does not trigger login propagation.

Because this behavior crosses a real process and OS credential boundary, implementation acceptance
also requires one smallest-path macOS check: refresh inventory through the daemon command environment
for a working Keychain login, observe catalog state `in`, then launch that same resolved Claude
executable successfully. Ordinary UI browser-driving is not required.

## 13. Acceptance criteria

The feature is complete when:

1. A current macOS Claude Keychain login is reported as `in` without `.credentials.json`.
2. A confirmed `claude auth status` logout is reported as `out`.
3. Keychain or command failures are visible as `unknown` and never initiate propagation.
4. The account identity returned by Claude reaches the fleet catalog without raw status logging.
5. Older command-incompatible, file-backed Claude installations retain correct detection.
6. Inventory and launch use the same resolved executable and command environment.
