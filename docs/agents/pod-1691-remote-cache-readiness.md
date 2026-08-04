# POD-1691 — remote-cache readiness

Remote caching is intentionally not enabled by this issue. The repository has no approved `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM`, or self-hosted cache endpoint, and no hosted service was signed up for or sent repository data.

## Cache-key audit

The environment fingerprint reaches the two current Turbo test tasks through the same path as typecheck:

- `scripts/test.ts` imports `readCensus` and `fingerprint` from `scripts/typecheck.ts`, refuses a missing or dangling `node_modules/@podium` install, and passes `PODIUM_CHECK_ENV_HASH` to `turbo run test`.
- `scripts/test-affected.ts` computes the same fingerprint for both its dry task-graph probe and the selected test run.
- `turbo.json` declares `PODIUM_CHECK_ENV_HASH` in `globalEnv`, so it is part of every task hash, including `@podium/web#test` and `@podium/mobile#test`.

Evidence from the rebased `origin/main` tree (Turbo 2.10.5, Bun 1.3.14):

- `bun run test:cached -- --dry=json` reported both `@podium/web#test` and `@podium/mobile#test`, with `PODIUM_CHECK_ENV_HASH` present in Turbo's configured global environment inputs.
- A controlled Turbo dry run changed only the environment value. The web task hash moved from `28533195e6d7e923` (`probe-env-a`) to `7e81b2d3e6b32b4d` (`probe-env-b`).
- The focused fingerprint and lane-configuration tests passed: 2 files, 21 tests.
- The existing task inputs explicitly include `packages/*/src/**` for both app tasks and `apps/daemon/src/**` for web, covering the known out-of-package source read identified by POD-1687.

The fingerprint itself is SHA-256 over the `bunfig.toml` contents plus the sorted names under `node_modules/@podium`, marking entries with no `package.json` as dangling. This closes the measured POD-1343 linker/layout failure: a missing or dangling workspace-link census cannot reuse a green. Turbo also includes the lockfile/package metadata in the global cache inputs.

The fingerprint is intentionally machine-portable: it hashes Bun configuration content and package names, not absolute checkout paths. Correctly installed checkouts on different machines and at different paths therefore produce the same environment hash.

The exact CI install command was reproduced from an initially empty `node_modules` in this worktree. Bun 1.3.14 installed 1,341 packages and created 26 healthy `@podium` workspace links with `--ignore-scripts`; `bun run test:web -- --dry=json` then passed the link guard and reached Turbo. If a CI install ever produces zero usable links, `scripts/test.ts` exits nonzero before Turbo, so the job hard-fails rather than reporting a cached green.

This is evidence for the current fleet shape, not a claim of arbitrary cross-platform hermeticity. The census records link names and dangling state, not symlink targets or installed package contents; Bun version, OS, and architecture are pinned by current CI (`ubuntu-latest`, Bun 1.3.14) but are not independently encoded by this fingerprint. If the rollout spans other runtimes or platforms, extend the fingerprint and re-run the hash probes before enabling remote reads.

The runtime identity is a required pre-sharing gate: add Bun version, OS, and architecture to `PODIUM_CHECK_ENV_HASH` (or equivalent `globalEnv` entries) before remote reads. Pinning all producers to the same Bun/OS/architecture is acceptable only if the remote cache is explicitly scoped to that fleet.

The census also does not hash valid symlink targets or their content. Before sharing, assert every `@podium` target resolves inside the checkout and that all resolved source is covered by task inputs, or add target/content identity to the key; otherwise a valid link into another checkout can reuse a green unseen by `$TURBO_ROOT$` globs.

## CI cache behavior

`bun run test:web` computes the fingerprint before invoking Turbo. On a successful cache hit, Turbo skips `bun --bun vitest --config vitest.config.ts run`, reports the cached task as a hit, and replays the successful task result/logs to CI. The real wrapper dry run in this worktree reported `status: HIT`, `source: LOCAL`, and `remote: false`; the existing POD-1687 evidence measured two cached lanes completing in 302ms. The current workflow caches only `~/.bun/install/cache`, not `.turbo`, so a fresh GitHub runner misses and executes the suite. A future remote hit is safe only when the audited source, lockfile, install-fingerprint, and fleet-runtime assumptions match; otherwise the fingerprint must be strengthened or the fleet must be partitioned before remote reads are enabled.

## Rollout gates

1. Land the `POD-1698` app-config safety fix. The web and mobile configs currently omit the root hermetic setup files; that is a separate live-instance safety issue, not a reason to weaken the cache key.
2. Choose and approve a self-hosted endpoint on the shared box, or explicitly authorize a hosted service. Keep tokens in CI/agent environment secrets; do not commit them or put them in `turbo.json`.
3. Configure the endpoint through the `TURBO_API`/token/team environment expected by the selected service, then verify one writer and an independent reader with `TURBO_REMOTE_ONLY=1`. Treat remote timeouts as infrastructure load unless the test task itself reports an assertion failure.
4. Keep the Turbo task pinned to the vetted packages until `POD-1699` gives additional packages real Vitest configurations. The current dry graph has only the web and mobile tasks; the other package `test` scripts are not safe task definitions yet.

CI currently ran the web package script directly (`bun run --cwd apps/web test:unit`), bypassing Turbo. This issue changes that step to `bun run test:web`, so CI will use the same task and can participate once an approved remote endpoint is configured. No remote cache is active in the current workflow.
