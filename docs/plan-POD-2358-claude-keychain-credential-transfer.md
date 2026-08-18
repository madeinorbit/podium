# Implementation Plan: Claude Keychain Credential Transfer

Status: ready for implementation · 2026-08-18 · POD-2358

Source specification: [Claude Keychain Credential Transfer](spec/claude-keychain-transfer.md)

## 1. Outcome

On Darwin, guarded native Claude credential export/install must use the macOS login Keychain service
that the same verified Claude CLI uses. Linux and Windows retain the current file backend. The server
continues to broker the existing storage-neutral `PortableCredentialBundle`; no credential bytes
enter argv, environment, disk, logs, inventory, or durable issue/server data.

This child owns daemon credential storage. It must not change Claude login-status parsing or harness
inventory policy; those belong to POD-2357.

## 2. Verified baseline

- `apps/daemon/src/control/credentials.ts` synchronously maps `claude-code` to
  `.claude/.credentials.json`, even for propagation with `realHome: true`.
- The same module already validates native Claude JSON with `hasValidClaudeCredential`, compares
  freshness through the manifest, refuses valid local targets, re-reads before install, and writes
  files atomically.
- `credentialExportRequest` and `credentialInstallRequest` are currently synchronous handlers. Their
  protocol bundles are storage-format neutral and need no schema change.
- The server already enforces same-owner donor selection, server-secret transit, target eligibility,
  retry/backoff, and secret cleanup in `apps/server/src/modules/machines/login-propagation.ts`.
- Current Claude 2.1.x uses Keychain service `Claude Code-credentials`, account `$USER`, or a service
  suffixed with the first eight lowercase SHA-256 hex characters of the explicit secure/config dir.
- Current Claude reads with `/usr/bin/security find-generic-password ... -w`, writes with
  `/usr/bin/security -i` using an `add-generic-password` command on stdin and hex data via `-X`, and
  serializes secure-storage writes with its `.storage-write` lock contract.

## 3. File ownership

The implementer owns:

- `apps/daemon/src/control/credentials.ts`
- `apps/daemon/src/control/credentials.test.ts`
- New modules/tests under `apps/daemon/src/control/` for credential-store routing and Claude Keychain
  compatibility
- `apps/daemon/package.json` and `bun.lock` only if the exact cooperative lock implementation requires
  a new dependency
- Minimal daemon context/composition changes needed to pass platform, command environment, and the
  resolved Claude version into storage routing

Avoid changes to protocol and server propagation unless a proven missing invariant requires them; the
bundle wire shape and result arrays should remain unchanged. Do not edit harness inventory, manifest,
or Claude status files owned by POD-2357. Mail POD-2347 before crossing either boundary.

## 4. Split policy from storage

Refactor credentials into an asynchronous store boundary while keeping validation and propagation
policy centralized. A suitable internal shape is:

```ts
interface CredentialStoreContext {
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string>>
  readonly resolvedClaudeVersion?: string
  readonly realHome: boolean
  readonly guarded: boolean
}

type CredentialReadResult =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly contents: Buffer; readonly revision: string }
  | { readonly state: 'unavailable'; readonly reason: CredentialStoreFailure }

interface PortableCredentialStore {
  read(): Promise<CredentialReadResult>
  guardedInstall(content: Buffer): Promise<boolean>
}
```

Keep file snapshots/install behavior in a file store so Codex, Grok, Claude state, and non-Darwin
Claude behavior do not change. Route only `kind === 'claude-code' && platform === 'darwin'` to the new
Keychain store.

Convert exported `readPortableCredential` and `installPortableCredential` to async, or introduce async
wrappers while retaining the sync file helpers internally. Update handlers through private async
functions and invoke them with `void`; preserve the `ControlHandlers` surface and exactly one result
frame per request. Process kinds sequentially to bound secret-bearing memory and child processes.

## 5. Context and routing

For each propagation request, obtain one current `harnessRuntime` snapshot before touching credentials.
Use its immutable `commandEnvironment.env` and resolved Claude version. If no runtime exists (legacy
tests), inject platform/env/version explicitly or fall back conservatively to process platform/env.

`realHome` means the daemon OS user's native credential store, not a provisioned managed-account home.
It still honors an explicit `CLAUDE_SECURESTORAGE_CONFIG_DIR` or `CLAUDE_CONFIG_DIR` from that native
command environment because that selects the Keychain item Claude actually reads. Never derive these
coordinates from a received bundle.

The Keychain backend must never be instantiated on non-Darwin. Tests inject `platform: 'darwin'` and a
fake process runner rather than invoking `/usr/bin/security` on Linux.

## 6. Pure Keychain coordinate module

Create a pure module with golden tests for account and service derivation.

Account precedence:

1. Non-empty command-environment `USER` matching `[A-Za-z0-9._-]+`.
2. Injected `os.userInfo().username` matching the same restriction.
3. Literal `claude-code-user`.

Service derivation:

1. Base is `Claude Code-credentials`.
2. If `CLAUDE_SECURESTORAGE_CONFIG_DIR` is defined, it wins; otherwise use defined
   `CLAUDE_CONFIG_DIR`.
3. Absent or empty selects the base service.
4. A non-empty value is normalized exactly as current Claude does, SHA-256 hashed, truncated to eight
   lowercase hex characters, and appended as `-<hash8>`.

Before coding normalization, recapture it from the supported installed Claude 2.1.x binary and commit
golden vectors for: absolute path, relative path, trailing slash, `..`, tilde text, Unicode NFC/NFD,
empty, and absent. Do not add `path.resolve`, home expansion, or Unicode handling that the CLI does not
perform.

For scoped export, try the scoped service first. Try legacy unscoped only after a genuine item-not-found
and only under the compatibility policy from the spec. Locked, denied, malformed, invalid, or
unavailable scoped state must never fall through. Install writes one authoritative derived service.

## 7. Injectable security runner

Create a narrow runner interface whose production implementation invokes absolute
`/usr/bin/security` with `execFile`/`spawn`, never a shell:

```ts
interface SecurityResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal?: string
  readonly timedOut: boolean
}
```

Rules:

- 12-second timeout, 1 MiB stdout/stderr caps.
- Read argv is exactly separate `find-generic-password`, `-a`, account, `-s`, service, `-w` entries.
- Write argv is only `/usr/bin/security -i`; build the `add-generic-password` command in memory and
  send it on stdin.
- Encode credential bytes as hex for `-X`. Account/service are locally derived restricted values;
  quote/escape the stdin command defensively anyway.
- Do not use `-A`, `unlock-keychain`, explicit Keychain passwords, temp files, or environment secrets.
- Never include stdout, stdin, plaintext/hex content, or raw stderr in errors/logs.

Capture the actual macOS item-not-found exit/diagnostic as a fixture. Only that verified result maps to
`absent`. Lock/session/interaction denial, timeout, signal, output overflow, and all unrecognized
non-zero exits map to bounded `unavailable` reasons.

Read accepts only a non-empty, at-most-1-MiB UTF-8 JSON object. Store a SHA-256 digest as the local
revision fence. Guarded export additionally requires `hasValidClaudeCredential` before constructing a
bundle.

## 8. Guarded Keychain install

Reuse the existing validator and `compareClaudeCredentialFreshness`; do not fork their logic into the
Keychain module. The algorithm is:

1. Strictly decode base64, enforce non-empty/1-MiB limit, parse JSON, and validate the incoming native
   Claude document.
2. Read target. `unavailable` fails closed. A valid local credential refuses install.
3. If invalid bytes exist, require the candidate to be strictly fresher; null/equal/older refuses.
4. Acquire the per-coordinate Podium mutex and Claude-compatible `.storage-write` cross-process lock.
5. Re-read and require the same revision plus the same validity/freshness decision.
6. Write through `security -i`, read back, and compare exact bytes.
7. Release locks in `finally`; only then report installed and trigger inventory refresh.

The current repository has no `proper-lockfile` dependency. Before adding one or implementing a lock,
verify the exact current Claude contract from the installed bundle: effective lock path, whether the
artifact is a file or directory, ownership payload, stale interval, retries, update heartbeat, and
release behavior. Add a compatibility fixture. Merely sharing the `.storage-write` name is not enough.

Existing-item replacement may use `-U` only while the proven cooperative lock is held. If the contract
cannot be proven or acquired, fall back to an atomic create-only command for a still-absent coordinate;
an occupied target returns false unchanged. Do not weaken this rule to a process-local mutex or claim
Keychain offers secret-value CAS.

Gate mutation to the explicitly verified Claude version family. Start with the captured 2.1.x contract;
unknown, unparsable, or uncovered versions may be read for export but must refuse install until their
coordinate/write/lock behavior is recaptured. Keep version parsing and the allow predicate pure/tested.

## 9. Existing transfer invariants

Do not change `PortableCredentialBundle`, server RPC schemas, or server donor policy. Confirm through
tests/code review that:

- `propagation: true` still selects guarded real-native storage.
- Only `claude-code` and `codex` are propagatable.
- The server still chooses an online same-owner donor, stores the bundle only in the temporary native
  login secret, clears it in `finally`, and applies existing retry/backoff.
- An environment API key or setup-token login with no native Keychain item exports unavailable.
- `claude setup-token` is not invoked and `CLAUDE_CODE_OAUTH_TOKEN` is never synthesized.
- A successful target install forces a fresh inventory report; failed/ambiguous installs do not.

Do not add failure details to the wire in this child. Keep bounded failure categories internal unless
product UX separately requires a protocol change.

## 10. Hermetic test matrix

Extend `credentials.test.ts` and add focused Keychain module tests covering:

- Backend route matrix for kind/platform/propagation mode; non-Darwin remains file-backed.
- Every account fallback and service golden vector, including secure-dir precedence.
- Scoped read success; scoped absent then legacy success; no fallback for scoped unavailable/invalid.
- Verified item-not-found versus locked, denied, headless-session, timeout, signal, overflow, malformed,
  invalid UTF-8, invalid JSON, and oversized content.
- Valid guarded export; invalid native contents unavailable; no secret in argv/env/log/error/temp file.
- Exact stdin hex command and absence of `-A`; write runner sees no credential in argv.
- Valid local refusal; invalid target with fresher/equal/older/uncomparable candidates.
- Second-read revision mismatch; lock acquisition failure; create-only fallback; concurrent occupied
  result; read-back mismatch; successful locked update.
- Unsupported Claude version refuses install without invoking the write runner.
- Handler returns exactly one result frame, awaits all store operations, and refreshes inventory only
  after at least one confirmed install.
- Existing Codex, Grok, Claude-state, path permissions, file CAS, and state-merge tests remain green.

Use synthetic tokens only. Fake runners must assert that secrets never appear in diagnostic strings.
Do not read or modify the developer's real Keychain in unit tests.

## 11. End-of-task validation

Follow the repository's one-end-of-task rule:

1. Run `bun run test` once after implementation is complete.
2. Because this changes daemon child-process behavior, run `bun run test:integration` once,
   sequentially after the lean gate.
3. Do not run browser or real-agent smoke lanes.

The Linux implementer cannot establish the Darwin boundary. Report these pending manual checks to the
parent rather than claiming them:

- A disposable uniquely scoped Keychain service can be read, create-only installed, locked updated,
  read back, and cleaned without touching a real Claude item.
- Two independent macOS machine runtimes transfer a test native login; target `claude auth status`
  becomes logged in and one minimal request succeeds.
- A concurrent Claude credential mutation wins or is serialized by the shared lock; no valid local
  credential is overwritten.

## 12. Done and handoff

The child is review-ready only when:

- Implementation and hermetic tests are committed on the child branch.
- Both selected validation commands and exact outcomes are reported.
- No secret-bearing output or fixture contains real credentials.
- No harness status files owned by POD-2357 were edited.
- Mail to POD-2347 includes the commit SHA, changed files, validation output, verified Claude version
  scope, lock-contract evidence, and the macOS manual checks still pending.
- The child is moved to `review` with a concise state and review offer. Do not merge or deploy.
