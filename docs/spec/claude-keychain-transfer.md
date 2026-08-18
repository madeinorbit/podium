# Spec: Claude Keychain Credential Transfer

Status: proposed · 2026-08-18

## 1. Decision

Podium adds a platform-aware storage backend for the native `claude-code` portable credential.
Darwin reads and writes Claude Code's login in the user's macOS login Keychain; file-backed platforms
continue to use `.claude/.credentials.json`. The portable bundle and server-side transfer flow remain
storage-format neutral.

The Darwin backend deliberately mirrors the current Claude Code Keychain coordinate and value format.
Anthropic does not expose an ordinary native-login export/import command, so automatic transfer cannot
be restored without this private compatibility boundary. All private assumptions are isolated in one
adapter and guarded by compatibility tests.

Login-state detection is specified separately in
[Claude Login Status Detection](claude-login-status-detection.md).

## 2. Context

The propagation flow in [Login propagation](../plan-POD-1708-login-propagation.md) already provides
the important distributed policy: same-owner donor selection, server-side temporary secret transit,
freshness checks, guarded target installation, refresh, retry caps, and backoff. Its assumption that a
Claude native credential is always a file is no longer true on macOS.

Current Claude Code stores a JSON credential document under these Darwin coordinates:

- Generic-password service: `Claude Code-credentials` for the default configuration.
- Account: the effective local username.
- Explicit config directory: service suffix `-<first 8 lowercase hex characters of SHA-256(dir)>`.

The value is the same JSON shape that Podium already validates with `hasValidClaudeCredential` and
compares with `compareClaudeCredentialFreshness`.

## 3. Goals

- Export a valid native Claude login from the macOS login Keychain.
- Install that login on another eligible macOS machine without exposing it to argv, environment,
  disk, logs, browser, or client APIs.
- Preserve Podium's existing owner, consent, donor, freshness, retry, and server-secret invariants.
- Refuse to replace a valid local login and avoid racing a concurrent Claude credential rotation.
- Preserve Linux and Windows file behavior.
- Isolate and test every Claude-private compatibility assumption.

## 4. Non-goals

- Synchronizing arbitrary Keychain items.
- Unlocking a Keychain or changing its password, ACLs, or global settings.
- Replacing native login with an implicit `claude setup-token` workflow.
- Copying `.claude.json`, settings, history, projects, or provider configuration as part of native
  credential propagation.
- Supporting multiple Claude identities within one Podium account beyond existing config-directory
  selection.
- Guaranteeing independent refresh-token rotation after a credential is copied.

## 5. Storage abstraction

Credential I/O becomes asynchronous and routes through a backend selected by credential kind,
platform, real-home policy, and command environment:

```ts
interface PortableCredentialStore {
  read(context: CredentialStoreContext): Promise<CredentialReadResult>
  guardedInstall(
    context: CredentialStoreContext,
    bundle: PortableCredentialBundle,
  ): Promise<CredentialInstallResult>
}

type CredentialReadResult =
  | { state: 'absent' }
  | { state: 'present'; contents: Buffer; revision: string }
  | { state: 'unavailable'; reason: CredentialStoreFailure }
```

The revision is an opaque digest or equivalent comparison token used only as a local second-read
fence. It is never transmitted. `unavailable` is not equivalent to `absent`.

Routing is normative:

| Credential | Platform | Backend |
| --- | --- | --- |
| `claude-code` | Darwin | Claude Keychain backend |
| `claude-code` | non-Darwin | Existing credential-file backend |
| Other kinds | All | Existing kind-specific backend |

The `PortableCredentialBundle` wire representation remains `{ kind, base64 }`. The server never
needs to know whether donor or target used a file or Keychain.

The existing `realHome` propagation option means the actual native user's credential store. It must
not silently redirect to a managed account's home or Keychain coordinate.

## 6. Darwin Keychain coordinate

### 6.1 Account

The adapter mirrors Claude's account selection:

1. Use a non-empty `USER` from the command environment when it contains only
   `[A-Za-z0-9._-]`.
2. Otherwise use `os.userInfo().username` when it satisfies that restriction.
3. Otherwise use Claude's compatibility fallback `claude-code-user`.

Account selection is computed locally and is never taken from a received credential bundle.

### 6.2 Service

The base service is `Claude Code-credentials`.

The effective secure-storage directory is an explicitly defined
`CLAUDE_SECURESTORAGE_CONFIG_DIR`; otherwise it is an explicitly defined `CLAUDE_CONFIG_DIR`.
Absent or empty values select the unscoped base service.

For a non-empty explicit directory, Podium normalizes the same string representation used by the
current Claude CLI, computes SHA-256, takes the first eight lowercase hexadecimal characters, and
uses:

```text
Claude Code-credentials-<hash8>
```

The normalization and hashing algorithm are compatibility-critical and live beside golden vectors
captured from a supported Claude release. Path resolution, Unicode normalization, trailing slash
handling, and `~` expansion must not be guessed independently by callers.

For export, a scoped coordinate is authoritative. The adapter may try the legacy unscoped service
only when the scoped item is genuinely absent and compatibility policy explicitly enables that
fallback. It must not fall back when the scoped item is unreadable, locked, malformed, or invalid.
Install writes only the derived authoritative service; it never duplicates a secret into both.

## 7. Keychain process boundary

### 7.1 General rules

- Invoke the absolute `/usr/bin/security` executable without a shell.
- Run as the daemon's effective OS user and with the same user session as Claude.
- Bound each operation to 12 seconds and 1 MiB of output.
- Never call `security unlock-keychain` or arrange an interactive password prompt.
- Never include credential bytes in argv, environment variables, filenames, errors, or logs.
- Treat locked, denied, missing-session, interaction-disallowed, timeout, and malformed-tool output as
  `unavailable`, not `absent`.

### 7.2 Read

Read a generic password with separate argv entries equivalent to:

```text
/usr/bin/security find-generic-password -a <account> -s <service> -w
```

Stdout is secret material. It stays in a bounded in-memory buffer, is validated, bundled, and then
released. It is never logged, even at trace level.

Only the documented item-not-found result is `absent`. Any other non-zero exit is classified into a
non-secret diagnostic reason. A present item whose bytes are not valid UTF-8 JSON or exceed the size
limit is present-but-unavailable; it is not permission to overwrite.

Export succeeds only when `hasValidClaudeCredential` accepts the document. An environment API key,
setup token, or logged-in catalog state without an exportable native item therefore fails closed.

### 7.3 Write

Writes use `/usr/bin/security -i` and send the batch command over stdin. Credential bytes are hex
encoded for `-X` inside that stdin command, matching Claude's current secure-storage write path.
No plaintext or hex secret appears in process argv.

The adapter must not use `-A` or otherwise widen Keychain access. It must match the access behavior
created by Claude's own `/usr/bin/security` path. A successful process exit is followed by a read-back
of the same coordinate and byte comparison before the install is reported successful.

Buffers containing plaintext, hex, or the stdin command must not survive longer than the operation.
JavaScript cannot guarantee physical memory zeroization, so the implementation must also avoid
copies that are not necessary for validation, comparison, or process input.

## 8. Guarded install and concurrency

The existing propagation guards remain mandatory:

1. Decode within the 1 MiB limit and validate the incoming Claude credential.
2. Read the target coordinate.
3. Refuse if a valid local credential exists.
4. If invalid content exists, require the incoming document to be strictly fresher according to
   `compareClaudeCredentialFreshness`.
5. Take the Claude-compatible secure-storage write lock described below.
6. Read again and require the same revision and the same validity/freshness decision.
7. Write, read back, and compare.
8. Release the lock and refresh inventory.

Claude currently serializes secure-storage mutation with a `.storage-write` lock in its effective
configuration directory. The Darwin adapter may replace an existing Keychain item only after its
supported-version compatibility fixture proves and acquires that same lock contract. Lock path,
stale interval, ownership, retry, and release behavior must match Claude rather than merely sharing a
filename.

If the cooperative lock contract is unavailable or cannot be acquired, the safe fallback is
create-only installation into a coordinate confirmed absent. The adapter must not use Keychain `-U`
to replace an existing item under only a best-effort in-process mutex. An occupied target then returns
a non-destructive `concurrent-or-occupied` failure and remains unchanged.

The per-coordinate Podium mutex still prevents two daemon requests from racing each other, but it is
not a substitute for the Claude-compatible cross-process lock.

No Keychain API exposed by this design provides a native compare-and-swap over secret value bytes.
The cooperative lock plus second read is therefore an explicit compatibility boundary, not a claim
that Keychain update itself is atomic CAS.

## 9. Transfer flow and policy

The server flow remains:

```text
eligible target
  -> same-owner online donor from catalog
  -> donor exports validated bundle
  -> server temporary native-login secret
  -> target guarded install
  -> inventory refresh and catalog confirmation
  -> secret cleared
```

The following existing rules are unchanged:

- The server is the only broker; peer-to-peer and browser transport are forbidden.
- The source and target must belong to the same authorized Podium account.
- The target must be observed logged out unless the existing explicit retry policy applies.
- A valid target login always wins.
- Managed-versus-personal machine consent policy remains in force.
- Existing absence grace, retry cap, backoff, and server-secret cleanup remain in force.
- Raw credential bytes never enter fleet inventory, account snapshots, durable server rows, telemetry,
  or user-facing errors.

Failure results should carry a bounded non-secret category internally, such as `item-not-found`,
`keychain-unavailable`, `invalid-source`, `valid-target`, `not-fresher`, `lock-unavailable`,
`concurrent-or-occupied`, or `readback-mismatch`. The existing protocol may remain success/failure at
the wire boundary unless product UX needs a user-actionable distinction.

## 10. Identity consistency

Donor selection uses the identity published by `claude auth status`. The server must bind the
transfer attempt to the donor catalog revision it selected and re-check same-owner authorization when
export and install RPCs are issued.

The credential JSON is not required to expose a trustworthy email identity. Podium must not parse an
unverified display identity from secret contents and must not reject a logged-out target merely
because it has no identity. After install, refreshed `auth status` is the authority. If it reports a
different known identity from the donor revision, Podium records a failed confirmation, stops retries,
and surfaces a non-secret mismatch; it does not copy more state in an attempt to fix the account.

## 11. Setup-token fallback

`claude setup-token` is not an automatic fallback for native credential transfer. It mints a
long-lived token, prints it, and expects `CLAUDE_CODE_OAUTH_TOKEN`; it does not recreate the ordinary
Keychain login and does not have identical product capabilities.

A future setup-token workflow must be explicit, separately consented, and modeled as a managed
environment secret with its own scope, expiry, revocation, and capability disclosure. Podium must not:

- Invoke `claude setup-token` during automatic propagation.
- Treat a copied OAuth access token as a setup token.
- Place native Keychain credential JSON into an environment variable.
- Report setup-token installation as native `/login` restoration.

## 12. Compatibility and rollout

All Claude-private details are confined to a `ClaudeKeychainCredentialStore` module. The generic
server protocol, donor policy, and other credential backends must not know Keychain service names or
`security` syntax.

Compatibility fixtures must include:

- Account selection vectors.
- Default and explicit-directory service-name vectors captured from a supported Claude release.
- A representative valid credential shape and freshness cases, with synthetic tokens only.
- Item-not-found and unavailable `security` result fixtures.
- The supported `.storage-write` lock behavior required for replacement.

If a future Claude release changes the coordinate, value schema, or lock contract, the adapter fails
closed and reports unavailable. It must not scan the user's Keychain for similarly named services or
overwrite an unrecognized item.

The file-only statements in the existing login-propagation plan are superseded for the
`claude-code`/Darwin route only. Its distributed policy and all other credential routes remain
authoritative.

## 13. Verification

Hermetic tests must cover:

- Backend routing by kind and platform.
- Username fallback and service derivation, including absent, empty, explicit, Unicode, relative,
  normalized, and trailing-slash config directory vectors.
- Scoped read, narrowly permitted legacy fallback, and authoritative scoped write.
- Item absent versus locked, denied, unreadable, oversized, malformed, and invalid.
- Valid export and bounded base64 bundle creation.
- No secret in argv, environment, logs, error text, or temporary files.
- Stdin hex write construction and no ACL widening.
- Valid-local refusal, strict freshness, second-read mismatch, lock failure, create-only fallback,
  read-back mismatch, and successful install.
- Same-owner authorization, temporary secret cleanup, retry/backoff, and post-install inventory
  confirmation through existing server tests.
- Linux and Windows remain on the file backend.

Implementation acceptance also requires the smallest real macOS boundary checks:

1. Against a uniquely scoped, disposable test service, verify `/usr/bin/security` read, guarded
   install, Claude-compatible locking, read-back, and cleanup of only the test item.
2. With explicit consent and non-production test credentials, transfer between two independent
   macOS machine runtimes, observe target `claude auth status` become logged in, and complete one
   minimal Claude request.
3. Start a local Claude credential mutation during a guarded install and verify that either the local
   mutation wins or Podium installs under the shared lock; no valid local credential is overwritten.

No browser-driving is required unless the implementation changes a browser interaction boundary.

## 14. Acceptance criteria

The feature is complete when:

1. A valid default or explicitly scoped macOS Claude Keychain login can be exported by the daemon.
2. An eligible logged-out macOS target can install it and subsequently reports logged in through
   `claude auth status`.
3. Valid local credentials, unreadable Keychain state, fresher/concurrent rotations, and unknown
   compatibility contracts all fail closed without overwrite.
4. Credential material appears only in bounded process memory, the temporary server secret, and the
   destination Keychain item.
5. Linux and Windows file propagation behavior is unchanged.
6. Setup tokens remain a separate, explicit future workflow rather than a silent fallback.
