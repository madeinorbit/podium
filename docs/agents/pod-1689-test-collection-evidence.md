# POD-1689 collection evidence

Measured in the issue worktree on 2026-08-05 with Vitest 5.0.0-beta.6 and Turbo 2.10.5.

## Collection method

The old default set was collected without executing tests:

- root `vitest.unit.config.ts`, both `node` and `normalized-wire` projects;
- `apps/web/vitest.config.ts`;
- `apps/mobile/vitest.config.ts`;
- the explicit `packages/runtime/test/sqlite.bun.test.ts` Bun unit file.

The new set was collected from every `#test` task in `turbo.json`:

- each package task's exact Vitest config, including mobile's auto-discovered config;
- the server package's separate normalized-wire config;
- the runtime package's explicit Bun unit file.

Vitest was invoked through `bun --bun node_modules/vitest/vitest.mjs list --filesOnly --staticParse --json`. Each result was normalized to a repository-relative path, sorted, and compared in memory.

## Exact result

| Set | Files | SHA-256 of sorted relative paths |
| --- | ---: | --- |
| Old default commands | 998 | `f5f46c7f67a39d30d993429107c34593963ec9f9cf19eb45fb664c11153b9d6a` |
| New package tasks | 998 | `f5f46c7f67a39d30d993429107c34593963ec9f9cf19eb45fb664c11153b9d6a` |

Both sorted lists are exact matches:

- old minus new: **empty**;
- new minus old: **empty**.

The identical SHA-256 is an additional check that the sorted list contents, not test results, were preserved.

## New task ownership

The 23 package tasks account for all 998 files:

- `@podium/cli` 26; `@podium/client-core` 81; `@podium/commands` 22;
- `@podium/composer` 2; `@podium/daemon` 55; `@podium/desktop` 1;
- `@podium/harness` 39; `@podium/issue-client` 3; `@podium/janitor` 1;
- `@podium/keyecho` 6; `@podium/mobile` 12; `@podium/model` 40;
- `@podium/protocol` 44; `@podium/pty` 5; `@podium/runtime` 21;
- `@podium/scripts` 47; `@podium/server` 285; `@podium/sync` 49;
- `@podium/telemetry` 7; `@podium/telemetry-relay` 1;
- `@podium/terminal-client` 25; `@podium/transcript` 12; `@podium/web` 214.

## Boundary audit

The suffix inventory contains 1,062 Vitest-like/Bun test files. The union of the default, integration, acceptance, agent-smoke, and all Bun collections contains 1,061; the one pre-existing remainder is `tests/e2e/mobile-web-smoke.spec.ts`.

That file is a Playwright smoke test outside the configured browser test match and is not part of the default Vitest migration. It is filed as Proposed [POD-1739](https://podium.local/issues/1739), linked `discovered-from` this issue, so it is visible work rather than silently dropped coverage.

## Cost and RSS

The prior measured web/mobile cache evidence was 2m33s cold and 302ms for a no-edit cached repeat ([POD-1687 evidence](pod-1687-test-cache-evidence.md)); that comparison covers those two tasks, not the full new 23-task default.

This issue measured the new desktop task as a bounded representative miss/hit pair:

- miss: 3 tests, 2.85s wall time including wrapper/lease, maximum RSS 129,444 kB (126.4 MiB);
- repeat: Turbo task 135ms (`>>> FULL TURBO`), 1.52s wall time including wrapper/lease, maximum RSS 96,496 kB (94.2 MiB).

The coordinator-requested full default benchmark then ran under a manually acquired
`test:heavy` lease. Both invocations used the normal `bun run test` command, measured
with `/usr/bin/time -v`; `PODIUM_SESSION_ID` was unset only in the child so the wrapper
would not try to reacquire the already-held lease.

| Run | Turbo result | Turbo time | Outer wall | Maximum RSS | Exit |
| --- | --- | ---: | ---: | ---: | ---: |
| Cold | 10 successful, 23 total; 1 cached, 23 total | 13m7.924s | 13m10.06s | 2,700,228 kB (2.57 GiB) | 1 |
| Immediate repeat, no source edits | 12 successful, 23 total; 10 cached, 23 total | 4m37.846s | 4m41.00s | 2,593,408 kB (2.47 GiB) | 1 |

Both runs stopped at the known rearchitecture-audit boundary in `@podium/scripts#test`;
they did not report a green result. A bounded rerun of the same `scripts/vitest.config.ts`
collected all 47 scripts files and identified the persistent failure as the pre-existing
`scripts/audit-god-objects.test.ts` ledger mismatch. The runtime `session-mint.test.ts`
tripwire was not reached in these aggregate runs. The repeat is therefore a partial-cache
measurement: the failed task must execute again and tasks ordered after the failure did not
get cache entries. Even with that limitation, the no-edit repeat reduced wall time by 64%.

The interactive shell remained responsive throughout both runs; `/usr/bin/time` reported
zero swaps and there was no OOM termination. No old root-sweep cold runtime was measured,
so this evidence does not claim a cold speedup over the former one-process sweep. The new
cold number is 13m10s on this shared 6-core host; serial Turbo scheduling (`--concurrency=1`)
does pay repeated Vitest startup costs, but is the deliberate RSS guard. The cache-hit
behavior is the material incremental improvement; a green repeat would be shorter than the
partial repeat above.

## Turbo dry run

`bun scripts/test.ts --dry=json` acquired and released the shared lease, then enumerated 23 `test` tasks with `--concurrency=1`; it did not execute a test file. The default wrapper carries `PODIUM_CHECK_ENV_HASH`, and Turbo's task definitions retain the shared hermetic/config inputs plus the explicit cross-tree inputs required by web/mobile and scripts.
