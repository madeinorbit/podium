# Native Harness Discovery Implementation Plan

Spec: [Harness executable environment](../../../spec/harness-executable-environment.md) · living spec `SP-58fa` · issue `POD-2280`

## Outcome

A daemon generation recovers the OS account's effective command environment once, verifies every harness executable from it, and carries the exact resolved executable and PATH through inventory and every launch boundary. Harness adapters keep only provider-specific executable declarations and invocation arguments.

## 1. Add the generic command environment

Files:

- `packages/runtime/src/command-environment.ts`
- `packages/runtime/src/command-environment.test.ts`
- `packages/runtime/package.json`

Implement an immutable `CommandEnvironment` with injected platform, environment, account lookup, subprocess runner, timeout, output limit, and generation. Only `PODIUM_DESKTOP_SUPERVISED=1` on POSIX hydrates the account login shell with a sentinel-framed `-ilc` probe. Merge shell PATH, inherited PATH, and deterministic fallbacks in that order; expose direct exec-style resolution and an environment whose PATH matches the resolver. Preserve Windows behavior without applying POSIX executable-bit rules.

Unit cases cover shell/home fallback chains, ANSI/sentinel parsing, timeout and malformed output, Homebrew prefixes, deduplication, executable-file rejection, Windows `PATHEXT`, and the negative systemd-marker case.

## 2. Centralize harness executable declarations and verification

Files:

- `packages/harness/src/manifest.ts`
- `packages/harness/src/inventory/build-inventory.ts`
- `packages/harness/src/executable-runtime.ts`
- `packages/harness/src/manifests/{claude-code,codex,grok,opencode,cursor}.ts`
- `packages/harness/src/{opencode,cursor}/cli.ts`
- relevant harness tests

Replace adapter-owned candidate probing with `HarnessExecutableDeclaration`: names, harness-only fallback candidates, version args, and optional identity probe. Build one `HarnessRuntimeSnapshot` containing the command environment, generation, wire inventory, and verified `ResolvedHarnessExecutable` values. Login identity reads use `credentialHome`; binary fallbacks use `machineHome`.

Remove the OpenCode/Cursor module caches, the availability TTL cache, and `HarnessBins`. Adapter launch/exec/headless builders return commandless specs; central binders attach the snapshot's absolute executable and effective environment. A missing or deleted executable produces an explicit error at that exact path and never triggers a second lookup.

## 3. Make the daemon own generation lifecycle

Files:

- `apps/daemon/src/harness-runtime.ts`
- `apps/daemon/src/host-runtime.ts`
- `apps/daemon/src/control/context.ts`
- `apps/daemon/src/daemon-options.ts`
- `apps/daemon/src/control/{inventory,session,exec,headless}.ts`
- `apps/daemon/src/{headless-drivers,durable-headless,harness-exec}.ts`
- relevant daemon tests and test context builders

Create the service during daemon composition after machine and credential homes are known. `current()` returns one immutable snapshot; `refresh()` starts a new generation and atomically makes it authoritative. Tag in-flight builds and discard completion/reporting from a superseded generation.

Route inventory, native login, PTY launch, one-shot exec, non-durable headless, durable/abduco headless, and child shell PATH through this service. Capture the snapshot before constructing `spawnEnv` so an already-started or adopted session never changes generation underneath itself. Keep the existing launch injection seam by making it a full resolved-launch test seam rather than a production resolver.

## 4. Route model and command probes through the snapshot

Files:

- `packages/harness/src/model-probe.ts`
- `apps/daemon/src/control/inventory.ts`
- quota modules only if the audit finds a harness subprocess boundary

Delete `probePath` and bare executable tables. Model probes receive the resolved executable map and command environment; Claude continues to read OAuth state from `credentialHome`. Audit quota/account fetchers and pass the snapshot anywhere they execute a harness command; HTTP-only readers remain unchanged.

Tests prove absolute executable and PATH propagation for each boundary, credential-home separation, generation races, and stale-session snapshot retention.

## 5. Add the requested Linux container acceptance proof

Files:

- `scripts/harness-environment-container-smoke.sh`
- `scripts/harness-environment-container-probe.ts`
- `docs/verification/POD-2280-native-harness-discovery.md`

Run the probe in two generic images with real passwd-backed users and materially different login shells (Debian/bash and Alpine/ash). Strip the parent PATH, expose fake Claude, Codex, Grok, and OpenCode executables only from login profiles, and assert inventory plus launch use the same absolute paths and effective PATH. The script is opt-in and reports a clean skip when Docker is unavailable.

## 6. End-of-task validation

Implement everything before testing. Then run the repository's normal `bun run test` gate once, followed sequentially by the user-requested Docker smoke once. Record image names, shell paths, resolved executables, and outcomes in the durable verification artifact. A manual macOS Finder/Homebrew launch remains release acceptance because Linux cannot prove the launchd boundary.
