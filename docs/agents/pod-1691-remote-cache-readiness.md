# POD-1691 — remote-cache readiness

Hosted remote caching is intentionally not enabled by this issue. The repository has no approved `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM`, or self-hosted HTTP endpoint, and no hosted service was signed up for or sent repository data.

What is enabled is a host-shared local Turbo cache for the wrapper-owned Turbo lanes. `scripts/typecheck.ts`, `scripts/test.ts`, and `scripts/test-affected.ts` now default `TURBO_CACHE_DIR` to a cache under `${XDG_CACHE_HOME:-/tmp/podium-cache}/podium/turbo/<repo-key>`; a relative `XDG_CACHE_HOME` is invalid and safely falls back to `/tmp/podium-cache`. The repo key is derived from the common Git directory, so sibling worktrees on the same checkout share hits. Callers that already set `TURBO_CACHE_DIR` keep their explicit cache location. CI explicitly sets and caches `/tmp/podium-cache/podium/turbo` for the `typecheck` and `unit-tests` jobs, so the Turbo-backed typecheck and web test lanes can reuse hits across CI runs without a hosted Turbo service.

## Cache-key audit

The environment fingerprint reaches the two audited Turbo test tasks in this tree through the same path as typecheck:

- `scripts/test.ts` imports `readCensus` and `fingerprint` from `scripts/typecheck.ts`, refuses a missing or dangling `node_modules/@podium` install, and passes `PODIUM_CHECK_ENV_HASH` to `turbo run test`.
- `scripts/test-affected.ts` computes the same fingerprint for both its dry task-graph probe and the selected test run.
- `turbo.json` declares `PODIUM_CHECK_ENV_HASH` in `globalEnv`, so it is part of every task hash, including `@podium/web#test` and `@podium/mobile#test`.

Evidence from the rebased `origin/main` tree (Turbo 2.10.5, Bun 1.3.14):

- `bun run test:cached -- --dry=json` reported both `@podium/web#test` and `@podium/mobile#test`, with `PODIUM_CHECK_ENV_HASH` present in Turbo's configured global environment inputs.
- A controlled Turbo dry run changed only the environment value. The web task hash moved from `28533195e6d7e923` (`probe-env-a`) to `7e81b2d3e6b32b4d` (`probe-env-b`).
- The integrated fingerprint, affected-lane, validation-boundary, and workflow-configuration tests passed: 4 files, 70 tests.
- The existing task inputs explicitly include `packages/*/src/**` for both app tasks and `apps/daemon/src/**` for web, covering the known out-of-package source read identified by POD-1687.

## Integrated package graph

The rebased tree includes the expanded package-owned test graph from POD-1699 and the lean lock model from POD-1899. Cache environment wiring now reaches the full package graph; typecheck and focused web/mobile/affected probes spawn Turbo directly, while the unfiltered full package lane alone enters `test:heavy`.

The fingerprint itself is SHA-256 over the `bunfig.toml` contents, Bun runtime identity (`Bun.version`, OS, architecture), and the sorted `node_modules/@podium` census. Healthy workspace links are recorded by package name plus their checkout-relative target; missing package metadata is marked `!DANGLING`, and links resolving outside the checkout are marked `!EXTERNAL` and rejected before Turbo runs. This closes the measured POD-1343 linker/layout failure and the later runtime/link-target gates: a missing, dangling, external, or cross-runtime install cannot reuse a green. Turbo also includes the lockfile/package metadata in the global cache inputs.

The fingerprint remains worktree-portable for correctly installed sibling worktrees because it hashes relative workspace targets, not absolute checkout paths. `bun run typecheck` imports no validation/admission helper, and all package `typecheck`/`typecheck:tsc` scripts invoke their compiler directly. The normal `bun run test:agent` gate now invokes this cached lock-free typecheck before its existing four-file probe. The exhaustive `bun run test` command also invokes typecheck first, then runs only its full package graph under `test:heavy`; focused web/mobile and affected probes spawn Turbo directly without a lease.

The exact CI install command was reproduced from an initially empty `node_modules`. Bun 1.3.14 created 26 healthy `@podium` workspace links with `--ignore-scripts`; cached wrappers then passed the link guard and reached Turbo. If an install has zero usable links or even one dangling/external link, the wrappers exit nonzero before Turbo, so the job hard-fails rather than reporting a cached green.

This is evidence for the current fleet shape, not a claim of arbitrary cross-platform hermeticity. Bun version, OS, architecture, and relative workspace-link targets are now independently encoded in `PODIUM_CHECK_ENV_HASH`; if a future rollout spans more machine-varying inputs, extend the fingerprint and re-run the hash probes before enabling remote reads.

The remaining remote-cache gate is service approval and fleet scoping. A host-local shared directory is active; a hosted or self-hosted HTTP cache still requires approved `TURBO_API`/token/team configuration and an independent writer/reader verification.

## CI cache behavior

On the pre-rebase implementation, a clean producer/independently-installed reader pair served 23/23 typecheck tasks from the common cache in 741ms (`FULL TURBO`). After rebasing onto POD-1899/POD-1699, the final isolated proof at `/tmp/podium-1691-final.k3oVO5` used an independently installed detached reader at the exact issue tip: producer and reader computed the same fingerprint/cache identity, the first reader replayed 20 producer artifacts and filled three producer artifacts that had not persisted, and subsequent producer/reader passes both exited zero against the converged shared cache. The workflow caches the explicitly matching `/tmp/podium-cache/podium/turbo` path, keyed by runner OS, Bun 1.3.14, `bun.lock`, branch, lane, and commit SHA, with lane/branch and same-lockfile restore prefixes.

## Rollout gates

1. Merge the `POD-1698` app-config safety fix. It is now in review with nonzero setup time and passing ambient-environment stripping proof; the unrelated POD-1402 root-gate tripwire does not change this cache audit.
2. Host-shared local cache is enabled by the wrappers, and CI persists that cache for the Turbo-backed jobs; verify sibling worktrees share `TURBO_CACHE_DIR` while preserving misses when `PODIUM_CHECK_ENV_HASH` changes.
3. Choose and approve a self-hosted endpoint on the shared box, or explicitly authorize a hosted service before enabling HTTP remote reads. Keep tokens in CI/agent environment secrets; do not commit them or put them in `turbo.json`.
4. Configure the endpoint through the `TURBO_API`/token/team environment expected by the selected service, then verify one writer and an independent reader with `TURBO_REMOTE_ONLY=1`. Treat remote timeouts as infrastructure load unless the test task itself reports an assertion failure.
5. After `POD-1699` integrates its 19 new cacheable package tasks, repeat per-task input/hash audits. Keep `terminal-client-react` intentionally excluded because it has no tests; do not enable remote reads until the expanded graph passes those gates.

CI previously ran the web package script directly (`bun run --cwd apps/web test:unit`), bypassing Turbo. This issue changes that step to `bun run test:web`; Actions cache now persists that local Turbo cache across CI runs. No hosted or self-hosted Turbo remote cache is active.
