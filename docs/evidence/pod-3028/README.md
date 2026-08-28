# Claude quota reset drive (current persistent SDK)

Internal acceptance under POD-1761. This is not a product change and does not
duplicate POD-2987.

## Provenance before any edit or launch

| Ref | SHA |
| --- | --- |
| This worktree HEAD | `45323df366cb9ac7156f7d1b4c02c39c706aaf33` |
| Local `issue/1761-agent-runtime` | `45323df366cb9ac7156f7d1b4c02c39c706aaf33` (identical) |
| Merge-base with local `main` | `0bd90092c3a926b9305da34547fcc51b1e19b0a7` |

`git merge-base --is-ancestor 45323df36 HEAD` holds. POD-3001
(`b6d403636`, persistent `packages/agent-runtime` Claude SDK RuntimeDriver) is
an ancestor. POD-3018 (`95b9c650e`, resume/adoption repair) is **not** an
ancestor of this tip; the drive is of the current 1761 persistent driver, not
that unlanded repair.

POD-2987 already proved interactive `claude-pty` and the old
durable-headless/process-per-turn `claude-sdk` at `8144307b4`. That evidence
stays at `docs/evidence/pod-2987`. This drive's new work is the current
persistent RuntimeDriver selected by `sessions.create` with
`runtimeContract: 'claude-sdk'` under `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1`, plus a
confirming interactive `claude-pty` control that omits `runtimeContract`.

## Window classification (read-only, no Claude launch)

Captured 2026-08-28T09:51:48Z through the production usage seam
`GET https://api.anthropic.com/api/oauth/usage` (`apps/daemon/src/quota-claude.ts`).
The access token was unexpired, so the GET cannot refresh OAuth. Live credential
mtime stayed `2026-08-28T06:20:34Z` after the GET.

| Fact | Value |
| --- | --- |
| OAuth | unexpired; access expiry `2026-08-28T14:20:34.109Z`; subscription `max` |
| Monthly spend | **not exhausted** (`spend.percent=0`, `spend.enabled=false`, `extra_usage.spend_limit_reached=false`) |
| Weekly all | **exhausted 100%**, `resets_at=2026-08-28T11:00:00Z` |
| Weekly scoped (Fable) | 32%, same reset |
| 5-hour | 0% |

Honest class: `claude-weekly-quota-exhausted; monthly-spend-not-exhausted; oauth unexpired`.
This is not OAuth expiry. It is also not the monthly-spend window POD-2987
observed on 2026-08-27. If a later check after 11:00 UTC shows weekly below 100%,
that recovery is recorded as-is; a failure will not be manufactured.

Coordinator mail claimed ~1.9 GiB free disk. Live `df` on this host at the same
session was **91.9 GiB** free, above the 5 GiB floor. Swap was idle (0B used).
Launch remains gated on that floor, on `node_modules/@podium`, on an unexpired
credential outside the ten-minute floor, and on a fresh named instance.

## Seams (exact production, no default-SDK)

- Interactive confirming path: `sessions.create({ agentKind: 'claude-code' })`
  with no `runtimeContract`. Manifest `select()` keeps `claude-pty`.
- Persistent SDK path: `sessions.create({ agentKind: 'claude-code', runtimeContract: 'claude-sdk' })`.
  Daemon env `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` makes the driver *available*;
  it is not selected unless the spawn names it. `PODIUM_RUNTIME_DRIVER` stays
  unset so the machine-wide default cannot move Claude off the PTY.
- SDK implementation on this tip: `createDaemonClaudeSdkRuntime` →
  `createClaudeSdkRuntime` → `runClaudeSdkChildTurn` → `apps/daemon/src/claude-sdk-host.ts`.
  Positive control is that host process, published `driverId=claude-sdk`, and
  TOS=1 on the daemon — not the old `superagent.sendTurn` durable-headless journal.
- No `HOME` / `PODIUM_STATE_DIR` / `PODIUM_AGENT_HOME` / `ABDUCO_SOCKET_DIR`
  override. No credential copy. Teardown must not delete the live credential.

## Constraints kept

- Do not enable the SDK by default.
- Do not refresh or copy credentials.
- Do not edit `docs/plans/pod-1761-results.tsv`.
- Do not run below the 5 GiB disk floor.
- Do not queue or wait for `test:heavy`.
- Preserve the current terminal fallback; no product changes here.
- File a separate sub-issue of POD-1761 for any durable classification repair.

## Drive (2026-08-28 12:00–12:04 CEST)

Named instance `p3028q-8280953`, ports 33028/47028/47029, pin `45323df36`.
Server PID 140419 and daemon PID 140522 both recorded `PODIUM_SPAWN_SHA` and
cwd of this worktree. Daemon had `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` and no
`PODIUM_RUNTIME_DRIVER`. No `HOME` / `PODIUM_STATE_DIR` / `PODIUM_AGENT_HOME` /
`ABDUCO_SOCKET_DIR` override. Live credential mtime stayed
`2026-08-28T06:20:34Z` through the usage GET, the drive, and teardown. No
isolated copy existed.

The product's account home for a named instance is
`$XDG_STATE_HOME/podium/<id>/agent-home`. This drive did not copy the operator
credential there. Claude on the PTY therefore ran as a first-start in that
empty home (`HOME` on the child was the agent-home). The product itself marked
both sessions `condition=logged-out`.

| Path | Positive control | Product result |
| --- | --- | --- |
| Confirming interactive `claude-pty` (no `runtimeContract`) | Claude 2.1.236 PID 140807 was a child of the instance abduco, cwd the PTY probe, 6424 terminal bytes. `sdkHostObserved=false`. DB `selected_driver_id=claude-pty`, `driverFamily=terminal`. Status API `driverId=null`. | First-run theme picker and subscription login UI. Send stayed `queued`. No quota text. Not operator OAuth expiry. |
| Persistent `claude-sdk` RuntimeDriver (`runtimeContract: 'claude-sdk'`) | Status `driverId=claude-sdk`, `driverFamily=embedded`, TOS=1 on daemon, machine default unset, no `headless-turns` dir. Resume UUID minted. Send `delivered`. | `phase=errored`, `error=null`, empty transcript, `condition=logged-out`. SDK host was not alive at sample time. No quota text. |

Provider usage at the same window remained weekly_all=100% (reset ~11:00 UTC)
with monthly spend 0% and OAuth unexpired. The product never reached that
provider quota surface on this no-copy named instance, so recovery after reset
is not claimed. A failure was not manufactured.

OAuth authorize URLs from the PTY first-run UI were redacted in the raw
reading. Leftover PTY Claude/abduco after daemon stop were killed; live
credential untouched.

## Selector / auth applicability (coordinator policy seam)

The Claude manifest still **declares** embedded `claude-sdk` auth as
`api-key` / `bedrock` / `vertex` only. Default `select({ auth: 'subscription' })`
stays on `claude-pty` even when the SDK is available.

The production resolver does **not** enforce that list on the opt-in path:
`runtimeContract: 'claude-sdk'` plus `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` returns
`claude-sdk` without reading `embedded.auth`. This drive observed that
(`driverId=claude-sdk` published). It did **not** reach the subscription
spend-limit window because the named instance agent-home had no credential and
the product classified both paths `logged-out`. No API-key test account was
supplied. Exact pins and doc list:
[`selection-policy.md`](selection-policy.md).

Implementation of a TOS-gated subscription declaration is **POD-3031**, already
in progress. This issue does not change product code.

## Classification gaps (not fixed here)

1. Status API still omits `driverId` on the failed first PTY turn even though
   the session row stored `selected_driver_id=claude-pty`.
2. Persistent SDK turn failure is `phase=errored` with `error=null` and no
   transcript item, so the reason (auth vs quota vs host death) does not cross
   the product boundary. POD-3007 covers the older 8144307b4 quota-class gaps;
   the persistent-driver silence is filed separately.

## Validation

Evidence, drive scripts, and named-instance boundary runs. No product code
changed on this branch (rebase onto 98ef8d6e0 only), so `bun run test` was
not run. `test:heavy` was not queued.

## Post-reset drive at 98ef8d6e0 (2026-08-28T11:00Z)

Rebased this issue branch onto local `issue/1761-agent-runtime` **`98ef8d6e0`**.
`git diff --name-only 98ef8d6e0 HEAD` is only `docs/evidence/pod-3028`. The
stale `45323df36` pin was not reused for this run. That tip already contains
`bcbbd6409` (subscription auth under the ToS gate): embedded.auth includes
`subscription`, and `select` routes subscription to `claude-sdk` when TOS
admits it. Explicit `runtimeContract=claude-pty` remains the fallback.

Absolute quota queries:

| UTC | weekly_all | action |
| --- | --- | --- |
| 2026-08-28T10:34:05Z | 100% until 11:00:00Z | park/poll |
| 2026-08-28T10:59:30Z | 100% | still parked |
| 2026-08-28T11:00:10.735Z | **0%** | reset confirmed; drive |

Named instance `p3028r-8281100`. Server PID 295487, daemon PID 295782,
`PODIUM_SPAWN_SHA=5f203cd43`. TOS=1 on daemon only. No credential copy. Live
mtime unchanged `2026-08-28T06:20:34Z`.

| Path | Control | Product |
| --- | --- | --- |
| Confirming `runtimeContract=claude-pty` | Status `driverId=claude-pty`, Claude 2.1.236 under instance abduco, 2410 terminal bytes, no SDK host | `condition=logged-out`; first-run theme/login chooser; send delivered; empty transcript; no resume |
| Persistent `runtimeContract=claude-sdk` | Status `driverId=claude-sdk`, embedded, TOS=1, resume `0bf2f0fb-…`, turn epoch 1 closed | `condition=logged-out`; `phase=idle`; `error=null`; empty transcript; no interactions |

Provider weekly-all after reset was **0%**. That is **not** the product
result. Both arms were `condition=logged-out` in an empty instance
agent-home. The SDK **positive control did not fire** (no host process, empty
transcript), so that arm is **unclassified / logged-out**, not quota. The
send-delivered / empty-transcript / `error=null` shape is **POD-3033**, not
a hidden quota class. See
[`final-classification.md`](final-classification.md).

## Pin retarget c55613bd7 (2026-08-28T11:06:43Z)

Coordinator named docs-only `c55613bd7` after the parked script. At retarget,
local `issue/1761-agent-runtime` had already moved to `976a62c38` (one further
docs commit). This branch was rebased onto that tip. `c55613bd7` is an ancestor
of HEAD. `git diff --name-only 98ef8d6e0 c55613bd7` is all `docs/`. Runtime
behavior is unchanged, so the post-reset drive was **not** re-launched (that
would only burn the new weekly window on another logged-out empty agent-home).
Quota at retarget: weekly_all=0%. See [`pin-c55613bd7.md`](pin-c55613bd7.md).
