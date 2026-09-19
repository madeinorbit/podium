# Retained harness management ownership

Install, login, model discovery, historical usage, account quota and quota-history
boot seed must remain available BEFORE any agent exists. Removing legacy PTY
session control must retain the following services; none may require an
`AgentSessionHandle`. This is the F11/F12 prerequisite for POD-3744, tracked by
this issue (`POD-4305`).

| Owner | Retained responsibilities |
| --- | --- |
| `apps/daemon/src/harness-management.ts` | Non-live boundary: `HarnessManagementContext` (send, machine identity, homes, harness runtime snapshot service, quota fetcher, usage memo — never bridges, observers, composer, scheduler, client terminals, headless turns or handle registries), `resolveManagementCredentialHome` (provisioned account HOME wins), `managementInventoryCacheKey` (per-machine per-home observation identity), `managementLoginCommandFor` (static manifest login argv, no handle). |
| `apps/daemon/src/harness-runtime.ts` (`DaemonHarnessRuntime`) | Generation-bound executable inventory and launch service: verified executable paths + command environment per generation, `reprobe` (reuse env, re-read login), `refresh` (new generation), `launch`/`bindHarnessLaunch` binding. Login and agent launches bind to the current snapshot, never a re-resolved binary. |
| `apps/daemon/src/control/exec.ts` (usage/quota/history arms) | Historical hour×model harvest with memoization + incremental cursor (`scanHostUsageSources`, `USAGE_MEMO_TTL_MS`), per-file historical-source attribution (`sources`, `sourcesSinceMs` only when asked), live account quota via TTL-cached fetchers (stale-while-revalidate, errors never cached), quota-history boot seed from harness files (`scanQuotaHistory`, empty when unreadable, machine-attributed). All take `HarnessManagementContext`. |
| `apps/daemon/src/control/inventory.ts` | Executable/version/login reprobes (`reportInventory`: harness-runtime `reprobe`/`refresh` wave, legacy `agentRuntime.inventory()` fallback, per-home cache, unprobeable eviction, forced-rebuild coalescing, version reporting), live model enumeration (`runModelProbe`: generation-resolved executables + command env, credential-home login reads, server secret never shipped down, empty catalog on failure). Both take `HarnessManagementContext`. |
| `apps/daemon/src/control/session.ts` (login arm only) | Native login argv resolves via `managementLoginCommandFor` before any handle can exist; unknown/unsupported harnesses throw instead of substituting. The login/plain-terminal path (`hostHasNoRuntimeSession`, `bindRuntimeContract` early return) shares launch, durable host, bridge, observers, screen and reaper with terminal handles but never creates or binds a terminal handle. Shell/login exemption itself is POD-4278; no shell manifest or driver is added. |
| `packages/harness/src/inventory`, `model-probe.ts`, manifests | Per-harness executable candidates, version probes (missing = `installed:false`, expired = `installed:null`), credential-home login reads (`harnessLoginReadEnv`), `loginCommand` declarations, model list parsers. Version admission (`gate*Version`, opencode2 drivable probe) decides which server drivers are advertised. |
| `apps/daemon/src/usage-scan.ts`, `quota-history-scan.ts`, `quota-fetch.ts` | Native evidence readers: transcript JSONL harvest (synthetic-sentinel exclusion, torn-tail cursors, subagent files), Grok billing-log recovery with account-email keying, per-agent quota fetchers with TTL + single-flight. Instance isolation via the calling HOME; nothing here starts an agent. |
| Server cost/quota/catalog consumers | `S/modules/cost`, `S/modules/misc-queries`, `ModelCatalog`: fold per-file sources into per-task cost, seed the ledger at boot from quota history, cache model lists per machine (stale-while-revalidate) with static-catalog fallback. |

`AgentSessionHandle.usage()` remains live-only: one session's context percentage or
a refusal. It is the compatibility read for live metadata, never the server's
historical/account source (see `docs/runtime/session-metadata.md`). Replacing the
management harvest with it would lose every closed session, every other account
home and the entire boot seed.

A moved credential home is not a new machine. Per-home cache keys precede any
shared snapshot; missing/stale homes fall back to provider resolution by native
identity. Without a daemon connection the server keeps its ledger, lake and
catalog; native scans resume when that machine is reachable, without starting
any agent process.

## Removal acceptance

Keep the management handlers, manifest readers and native evidence scanners until
replacement services provide all of these responsibilities. Moving their
implementation is optional; deleting them because they sit outside the live
contract is not. Live-session cleanup (kill/reap/close) must never retire them:
they are keyed by machine and credential home, not by session.

Focused preservation evidence:

- `apps/daemon/src/harness-management.test.ts`: credential-home preference +
  multi-home separation, per-home cache isolation, static login argv per harness
  with no substitution, management handlers answering with no live services,
  historical-source attribution (`withSources`), closed-transcript harvest,
  quota boot seed with machine attribution, uninstalled/logged-out admission,
  model probe credential-home reads, login binding the generation snapshot with
  no terminal handle.
- `apps/daemon/src/control/inventory.test.ts`: report/cache/rebuild/reprobe,
  version gating, model probe home + failure answers.
- `apps/daemon/src/quota-fetch.test.ts`: TTL memoization, error isolation.
- `apps/daemon/src/control/session-plain-terminal.test.ts`: login/shell arms
  never create or bind a terminal handle.

The original removal-gap evidence is pinned to
`692d8c8e8f5465112dadeff50df0f0be817e9e51`; these owners are established against
`integration/3738-driver-contract`, not a change to the live-only driver scope.
