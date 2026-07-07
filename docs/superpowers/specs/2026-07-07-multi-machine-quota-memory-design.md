# Multi-machine: usage-limits overlay + memory screen per-machine

Issue #136. Two dev machines (`podium-host`, `vmi`) are attached to one server, each
running its agents under a **different** Claude account. Two host-scoped UI
features still assume a single machine:

1. **Quota (usage-limits) overlay** (`QuotaIndicator`) only ever shows one
   machine's account/limits.
2. **Memory screen** (`HostIndicators` chip → `HostInfoView`/`MemoryPanel`) shows
   the *wrong* machine: clicking the `vmi` chip shows `podium-host`'s memory.

## Root cause (shared)

Both features collapse to the first online daemon. `agentQuota()` and
`memoryBreakdown()` call `daemonRequest(...)` with **no `machineId`**, so it
defaults to `defaultMachine()` = `onlineMachineIds()[0]` (relay.ts:2200). The
memory chip's click handler also discards the clicked `host.machineId`
(HostIndicators.tsx:89) and `MemoryPanel` hard-codes `hostMetrics[0]`
(HostMemoryView.tsx:185).

Everything else is already machine-aware: per-machine host metrics reach the
client (`HostMetricsWire.machineId`), the machine list is in the store
(`machines: MachineWire[]`), sessions/spawn/repo-discovery all route by
`machineId`, and `scanReposAll()` (repo-registry.ts:119) is a working
fan-out-to-all-online-machines template.

## Part A — Memory screen (bug fix, machine-aware)

**Client**
- `HostIndicators.tsx`: replace `infoTab: HostInfoTab | null` with an object
  `info: { tab: HostInfoTab; machineId: string } | null`. The per-host memory
  chip's `onClick` captures `host.machineId`. The connection glyph passes the
  default machine (connection is machine-agnostic; the Connection tab already
  lists all hosts).
- `HostMemoryView.tsx`:
  - `HostInfoView` takes `machineId: string`, forwards it to `MemoryPanel`.
  - `MemoryPanel` selects its host by id —
    `hostMetrics.find(h => h.machineId === machineId) ?? hostMetrics[0]` — for the
    instant headline, and passes `{ machineId }` to
    `trpc.hosts.memoryBreakdown.mutate({ machineId })`.

**Server**
- `Relay.memoryBreakdown(roots, machineId?)` → `daemonRequest(..., machineId ?? defaultMachine())`.
- `hosts.memoryBreakdown` route accepts `input: { machineId?: string }`. When a
  `machineId` is given, derive that machine's roots
  (`repos.list(machineId)` scanned for worktrees via `scanReposForMachine`,
  maxDepth 0) and call `memoryBreakdown(roots, machineId)`. Omitted → unchanged
  (default machine, all-machine roots) so single-machine behavior is identical.

## Part B — Quota overlay (grouped by machine)

Chosen presentation: **one overlay, grouped by machine** (single strip glyph;
dialog has a section per machine).

**Protocol**
- Add `MachineQuotaWire = { machineId, machineName, hostname, agents: AgentQuotaWire[] }`.
  The daemon↔server request/result wire (`AgentQuotaRequest/Result`) is
  unchanged — the server fans out N single-machine requests and tags each reply.

**Server**
- `Relay.agentQuota(refresh?, machineId?)` gains a `machineId` param
  (default `defaultMachine()`), passed through to `daemonRequest`.
- New `Relay.agentQuotaAll(refresh?): Promise<MachineQuotaWire[]>` — fans out to
  `onlineMachineIds()` with `Promise.all` (the `scanReposAll` pattern), tagging
  each reply with `machineId` + `machineName(id)`. Empty when no daemon online.
- `quota.summary` route returns `agentQuotaAll()`.
- Single-machine invariant: one online daemon → array length 1 whose `agents`
  equal today's `agentQuota().agents`.

**Client** `QuotaIndicator.tsx`
- `quota.summary.query()` now yields `MachineQuotaWire[]`; store as `machines`.
- Strip glyph severity = worst window across **all** machines' `ok` agents
  (`worstPercent` over the flattened agents).
- Tooltip: per machine (name → per-agent windows) when >1 machine, else the
  current per-agent lines.
- Dialog: one section per machine. Show a machine header (name · hostname) only
  when `machines.length > 1` (mirrors `HostIndicators` `showHostname`); a single
  machine keeps today's flat card list. Reword the footer from "on the dev
  machine" to "on each dev machine".

## Scope

- Only the rate-limit overlay (`QuotaIndicator`). The separate transcript token-
  cost view (`UsageView` / `usage.summary`) is out of scope.
- Offline machines are omitted from the quota fan-out (memory chips already only
  render for hosts reporting metrics).

## Testing

- **Server unit**: `agentQuotaAll()` fans out to two machines → two entries tagged
  with the right `machineId`/`machineName`; one machine → one entry matching
  `agentQuota()`. `memoryBreakdown`/`agentQuota` route to the requested machine
  (assert `toMachine`/`daemonRequest` target). Model on
  `repo-registry.machines.test.ts`.
- **Client component**: `QuotaIndicator` renders a section per machine and the
  glyph reflects the worst machine. Clicking machine B's memory chip issues
  `memoryBreakdown({ machineId: B })` (mocked trpc).
- **Runtime**: with both `podium-host` + `vmi` attached — click the `vmi` memory
  chip → shows `vmi`; open the quota overlay → two account sections. (This repo
  requires real-click verification for interactive UI, not just build+unit.)

## Backward compatibility

Single online daemon everywhere collapses to length-1 arrays / default machine,
so the one-machine UI and behavior are unchanged.
