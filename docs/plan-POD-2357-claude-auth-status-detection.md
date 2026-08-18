# Implementation Plan: Claude Auth Status Detection

Status: ready for implementation · 2026-08-18 · POD-2357

Source specification: [Claude Login Status Detection](spec/claude-login-status-detection.md)

## 1. Outcome

Machine inventory must report the state returned by the exact verified Claude executable's
`auth status` command. A current macOS Keychain login becomes `in`, a valid provider-reported logout
becomes `out`, and all command, parse, or Keychain failures become `unknown`. The existing
credential-file detector remains only the capability fallback for an older CLI that does not have
the command.

This child owns harness inventory probing. It must not change daemon credential export/install,
server propagation policy, or Keychain storage code; those belong to POD-2358.

## 2. Verified baseline

- `packages/harness/src/inventory/build-inventory.ts` currently calls synchronous
  `detectLogin(credentialHome)` before it resolves an executable. `ProbeExec` returns stdout only and
  rejects non-zero exits, so it cannot represent Claude's documented logged-out exit 1.
- The same file already resolves absolute candidate paths and passes the generation-bound
  `CommandEnvironment.env` to version and identity probes.
- `packages/harness/src/manifests/claude-code.ts` currently reads
  `.claude/.credentials.json` and enriches identity from `.claude.json`.
- `apps/daemon/src/harness-runtime.ts` owns immutable inventory generations and reuses the same
  command environment for reprobes and launches.
- `harnessDetectLogin()` in `packages/harness/src/registry.ts` is now a compatibility surface; the
  production account view consumes machine inventory through the fleet catalog.
- Current Claude returns JSON fields including `loggedIn`, `authMethod`, `apiProvider`, `email`,
  `orgId`, `orgName`, and `subscriptionType`; exit 0 means logged in and exit 1 means logged out.

## 3. File ownership

The implementer owns:

- `packages/harness/src/manifest.ts`
- `packages/harness/src/inventory/build-inventory.ts`
- `packages/harness/src/inventory/build-inventory.test.ts`
- `packages/harness/src/manifests/claude-code.ts`
- A new pure parser module/test beside the Claude manifest if useful
- The minimal declarations in the other harness manifests required by a typed manifest contract
- `packages/harness/src/registry.ts` and its compatibility tests when comments/types need adjustment
- `apps/daemon/src/harness-runtime.ts` and its tests only for injecting the new probe seam

Do not edit `apps/daemon/src/control/credentials.ts` or any Keychain backend. POD-2358 owns those
files. If an unexpected shared interface is required, mail POD-2347 before editing across that line.

## 4. Manifest contract

Add a manifest-declared command login probe rather than branching on `kind === 'claude-code'` in
generic inventory code. Keep the command result type independent of Node's `ExecException`, for
example:

```ts
export interface LoginCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal?: string
  readonly timedOut: boolean
  readonly errorCode?: string
}

export type LoginCommandDecision =
  | { readonly kind: 'determined'; readonly login: HarnessLogin }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'unknown'; readonly reason: string }

export interface HarnessLoginCommandProbe {
  readonly args: readonly string[]
  readonly timeoutMs: number
  classify(result: LoginCommandResult): LoginCommandDecision
}
```

Declare the feature on `HarnessInventory`, preferably with the repository's `Declared<T>` pattern so
unsupported manifests are explicit. `detectLogin(homeDir)` remains the synchronous file fallback for
this change; do not rename every detector in the same patch.

The `reason` is a bounded classification for logs/tests, not provider output. It must never carry raw
stdout, stderr, email, or credential material.

## 5. Process runner

Add an injectable `LoginProbeExec` used only for command login probes. Preserve the existing
`ProbeExec` API for version/tool probes so this feature does not force unrelated test churn.

The production runner must:

1. Use `execFile`, never a shell.
2. Receive `[resolvedExecutable, ...probe.args]` and the exact immutable
   `CommandEnvironment.env` object used by the version probe and launch binding.
3. Return stdout, stderr, exit code, signal, timeout state, and a bounded OS error code even for
   non-zero exits.
4. Use a 12-second timeout and 1 MiB stdout/stderr bounds.
5. Convert spawn errors, timeout kills, signals, and max-buffer failures into results rather than
   throwing out of inventory.

Expose the seam through `BuildInventoryOptions` and thread it through `DaemonHarnessRuntime` build,
refresh, and reprobe paths. Existing callers that inject only `ProbeExec` must remain valid.

## 6. Pure Claude classifier

Keep parsing and unsupported-command recognition in a pure function owned by the Claude manifest.
The classifier must implement this table exactly:

| Result | Decision |
| --- | --- |
| JSON object, `loggedIn === true`, exit 0 | determined `in` |
| JSON object, `loggedIn === false`, exit 1 | determined `out` |
| Valid object but flag/exit disagreement | `unknown` |
| Missing/non-boolean flag, malformed or excess output | `unknown` |
| Timeout, signal, launch error, Keychain denial/lock/session error | `unknown` |
| Narrow, verified old-CLI “subcommand unsupported” signature | `fallback` |

Requirements:

- Trim surrounding whitespace, then require exactly one JSON object. Do not scrape JSON out of prose.
- Ignore unknown object properties.
- On `in`, trim `email`; when non-empty, set `account` and create identity with
  `fingerprintForLoginIdentity(email)`. Do not fingerprint `orgName`.
- If email is missing, use `orgName` only as a display account; otherwise use `Claude login`.
- Do not merge stale `.claude.json` identity into an authoritative command result.
- Inspect bounded stderr only to detect a Keychain error or the verified unsupported-command
  signature; never log it.
- Unsupported recognition must be narrow. Capture or cite an actual older Claude diagnostic in the
  test fixture. Generic exit 1, “not logged in”, malformed JSON, or an arbitrary “unknown” message is
  not sufficient.

## 7. Inventory algorithm

Refactor `probeAgent` in this order:

1. Compute the existing file fallback and fallback identity defensively, without publishing them yet.
2. Resolve each candidate and complete the existing version/identity verification.
3. Once a candidate is verified, run its declared login command using that exact candidate path.
4. Publish a determined command result without file identity enrichment.
5. Publish file state plus file identity only when the classifier explicitly returns `fallback`.
6. Publish `unknown` when the command classifier returns `unknown`; the executable still remains
   `installed: true` with its version/path.
7. If no executable resolves, retain valid file-backed `in` compatibility. On Darwin, a missing/empty
   Claude file for a command-capable manifest becomes `unknown`; on non-Darwin it retains the current
   file result. Pass platform into the internal policy as an injectable value or test a pure policy —
   do not make Linux CI impersonate Darwin through ambient global mutation.

Other harnesses must retain byte-for-byte-equivalent inventory behavior.

Do not synthesize `CLAUDE_CONFIG_DIR`. Preserve absent, empty, and explicit values already carried by
`CommandEnvironment.env`; this is required for Claude's unscoped versus hashed Keychain selection.

## 8. Compatibility surface

Keep `harnessDetectLogin(kind, homeDir)` synchronous for now and document that it exposes only the
manifest's local fallback. Do not make server code shell out and do not add a second status probe to
session launch.

The inventory refresh cadence remains the only poll. A failed command affects only `login`; it must
not suppress the verified executable, version, tools, or other agents.

## 9. Hermetic test matrix

Extend `build-inventory.test.ts` and/or add a focused Claude classifier test covering:

- The resolved absolute candidate, `['auth', 'status']`, 12-second timeout, and exact environment.
- Logged-in JSON with email identity; logged-in JSON without email; valid logged-out JSON.
- Exit/flag contradictions in both directions.
- Malformed JSON, array/null/scalar JSON, missing `loggedIn`, overflow, timeout, signal, spawn error,
  and representative Keychain errors all become `unknown`.
- The one verified unsupported-command fixture becomes file fallback.
- A generic exit 1 or unknown error does not become fallback.
- Darwin: no credential file + command says logged in => `in`.
- Darwin: no executable + missing file => `unknown`.
- Older unsupported CLI + valid file => `in`; older unsupported CLI + absent file => `out`.
- Explicit and absent `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` arrive unchanged.
- Command `unknown` does not acquire stale `.claude.json` identity.
- Command failure leaves `installed`, `version`, and `path` intact.
- Existing Codex, Grok, Cursor, OpenCode, and tool inventory expectations remain unchanged.
- `DaemonHarnessRuntime.reprobe()` reuses the same command environment and injectable login runner.

Tests must not invoke a real Claude binary or inherit real host credentials.

## 10. End-of-task validation

Follow the repository's one-end-of-task rule:

1. Run `bun run test` once after implementation is complete.
2. Because this adds a real child-process/agent-adapter boundary, run `bun run test:integration` once,
   sequentially after the lean gate.
3. Do not run `test:smoke:agents`; real-agent smoke requires an explicit human request and spends
   credentials/quota.

The Linux implementer cannot establish the macOS Keychain boundary. In the handoff, call out the
remaining smallest-path macOS check from the spec: daemon inventory refresh sees `in` for a working
Keychain login and launches the same resolved executable successfully.

## 11. Done and handoff

The child is review-ready only when:

- The implementation and hermetic tests are committed on the child branch.
- Both selected validation commands and their exact outcomes are reported.
- No raw status output is logged.
- No daemon credential or Keychain files were edited.
- A mail to POD-2347 gives the commit SHA, changed files, validation output, and the explicit macOS
  boundary check still pending.
- The child is moved to `review` with a concise state and review offer. Do not merge or deploy.
