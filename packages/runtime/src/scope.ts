/**
 * RESOURCE SCOPES: the slice tree, the budgets, and the argv that applies them
 * (POD-2413 for sessions, POD-2472 for builds; agent-runtime spec §6).
 *
 * It lives in `@podium/runtime` because it has TWO consumers on opposite sides
 * of a dependency boundary: the daemon scopes agent sessions through
 * `@podium/pty`, and the server scopes development builds
 * (`apps/server/src/modules/updates/build-scope.ts`). `check-boundaries.ts`
 * rule 2 keeps `@podium/pty` out of the server — reasonably, since importing it
 * means driving real PTYs — so a home inside pty would have left the server
 * writing a SECOND resource policy. Two policies drift; one does not.
 *
 * A transient `--user` scope already kept an agent alive across a redeploy
 * (see `abduco.ts`). What it never did was BOUND one: every session ran with
 * unlimited memory, unlimited tasks, and the host's own OOM policy, so a single
 * runaway agent could take the machine down — and twice did. This module is the
 * missing half. Scope creation stays exactly where it was; what changes is that
 * every scope is now placed in an instance-owned slice and carries a budget.
 *
 * ```
 * podium.slice                                  (or podium-<instance>.slice)
 * ├─ podium-sessions.slice                      MemoryHigh= (aggregate THROTTLE)
 * │  ├─ podium-<sessionId>.scope                MemoryMax/SwapMax, TasksMax, OOMPolicy=continue
 * │  └─ podium-oc-attach-<sessionId>.scope      a client TUI, reclaimed FIRST
 * └─ podium-builds.slice                        MemoryMax=  (aggregate CAP)
 *    └─ podium-dev-bundle-build.scope           MemoryMax/SwapMax, TasksMax, OOMPolicy=continue
 *
 * (No scope carries a `MemoryHigh` by default — trap 1. The session knob still
 * accepts one as an explicit reclaim-only policy; a build has no such knob.)
 * ```
 *
 * BUILDS ARE A SIBLING OF SESSIONS, NOT A MEMBER — twice deliberately.
 *
 * Placement: `scope-monitor.ts` reads the SESSIONS slice's memory pressure and
 * the reclaim policy parks sessions on it. A build inside that slice would make
 * every redeploy read as session memory pressure and park innocent agents; a
 * repo typecheck run in the sessions slice was measured taking that trigger from
 * 11 firings to 40. Builds still get bounded — they just do not contaminate the
 * signal the reclaim reads.
 *
 * Budget: the sessions slice carries a `High` and never a `Max`, because
 * collective OOM death of every agent on the box is the one outcome the spec
 * forbids. The builds slice carries a `Max`, because collective death of BUILDS
 * is not a catastrophe — it is the correct answer. A build is restartable, it
 * owns no conversation, and a build killed at its ceiling fails visibly with the
 * kernel's own exit 137 while the sessions beside it keep running.
 *
 * The attach scope's NAME is the client terminal's own durable label, which is
 * deliberately not a suffix of the session's (see `opencode-attach.ts`: memory
 * attribution is a substring test, so `…-<id>-attach` would bill the client's
 * memory to the agent). What makes it an attach scope here is its ROLE, which
 * sizes it — a terminal client, not a workload.
 *
 * The daemon and server units stay OUTSIDE the sessions slice on purpose: the
 * supervisor must never share an OOM fate with what it supervises.
 *
 * TWO POLICY TRAPS, both measured on a live user manager (systemd 259, cgroup
 * v2) — the three-arm measurement is in
 * `docs/architecture/pod-2413-resource-isolation.md`:
 *
 *  1. `MemoryHigh` DOES NOT KILL — it throttles reclaim, and ANY high below max
 *     can wedge a runaway instead of ending it. The first cut of this file set
 *     it to 90% of `MemoryMax` on the theory that a narrow band was safe; it is
 *     not. Measured: high at 90% with swap allowed produced NO KILL and
 *     thousands of reclaim-throttle events, because a workload whose demand
 *     exceeds the ceiling never escapes throttling at the high line to reach
 *     the max line where the kill lives. So the default sets NO high at all:
 *     `MemoryMax` is the kill line, and `MemoryHigh` remains available as an
 *     explicit reclaim-only policy for an operator who wants throttling instead
 *     of killing.
 *  2. `MemoryMax` alone does not bound a runaway on a host with swap — the
 *     kernel simply pages it out (a probe allocated 1.6 GiB under a 64 MiB cap
 *     and finished normally, on a host with 40 GiB of swap). And swap is a
 *     SEPARATE cgroup v2 limit, so `MemorySwapMax=MemoryMax` does not bound the
 *     total at max — it doubles it, which on a small host is more than the RAM
 *     the budget was derived from. The default is therefore `MemorySwapMax=0`:
 *     one number, and it means what it says.
 */

import { totalmem } from 'node:os'
import { createLogger } from '@podium/logger'

const log = createLogger('pty:scope')

/** What a scope holds: an agent's whole process tree, or one attached TUI. */
export type ScopeRole = 'session' | 'attach'

/**
 * One scope's budget. `undefined` is not "zero" — it means UNBOUNDED on that
 * axis, which is what an operator gets by setting the knob to `infinity` and
 * what every non-Linux platform gets by construction.
 */
export interface ScopeBudget {
  memoryHighBytes?: number
  memoryMaxBytes?: number
  memorySwapMaxBytes?: number
  tasksMax?: number
}

/**
 * Swap allowed to a session scope, as a fraction of its memory ceiling.
 *
 * ZERO, so `MemoryMax` is the whole bound. Swap is an independent cgroup v2
 * limit, so anything above zero ADDS to the ceiling rather than fitting inside
 * it; an operator who wants an allowance sets one explicitly.
 */
const SWAP_FRACTION = 0

/** Per-session share of host RAM, and the floor/ceiling it is clamped into. */
const SESSION_MEMORY_SHARE = 0.5
const SESSION_MEMORY_FLOOR = 2 * 1024 ** 3
const SESSION_MEMORY_CEILING = 16 * 1024 ** 3

/** An attached TUI is a terminal client, not a workload. */
const ATTACH_MEMORY_MAX = 1024 ** 3
const ATTACH_TASKS_MAX = 256

/** A session tree is an agent plus builds, test runners and browsers. The cap
 *  exists to stop a fork bomb, not to size normal work. */
const SESSION_TASKS_MAX = 4096

/** Aggregate throttle for ALL sessions of an instance. Deliberately a `High`
 *  and never a `Max`: the one thing the spec forbids is collective OOM death,
 *  so the sessions slice throttles as a group and kills only per session. */
const SESSIONS_SLICE_SHARE = 0.75

/**
 * WHAT ONE DEVELOPMENT BUILD MAY TAKE (POD-2472).
 *
 * Not a share of host RAM, because a build's appetite does not scale with the
 * box: the compile and the two dists want what they want, and doubling the RAM
 * does not make them want more. So the default is the MEASURED peak with
 * headroom. Each real update-build step, run in its own scope on this host and
 * read from the cgroup's own `memory.peak` (the larger of two runs):
 *
 * | step                                  | peak     | tasks | wall  |
 * |---------------------------------------|----------|-------|-------|
 * | `@podium/web build:dist` (vite)       | 1.26 GiB |    40 | 73 s  |
 * | `@podium/mobile build:web` (expo)     | 1.07 GiB |     — | 428 s |
 * | `scripts/build-bun.ts` (compile+tar)  | 712 MiB  |    17 | 17 s  |
 *
 * 4 GiB is a bit over 3x the largest, which is the right shape for a ceiling
 * that must never kill a legitimate build: builds grow, and an update path that
 * dies at its own cap is worse than one that is slow. The steps also overlap
 * only in pairs (the two website steps are sequential), so the aggregate below
 * clears their combined peak with room to spare.
 */
const BUILD_MEMORY_CEILING = 4 * 1024 ** 3

/**
 * And the share that keeps that ceiling honest on a smaller box, where a cap
 * above host RAM would bound nothing at all — it is also the aggregate cap on
 * the builds slice itself ({@link resolveBuildsSliceBudget}).
 */
const BUILDS_SLICE_SHARE = 0.5

/**
 * A build tree is bun, turbo, vite and their worker pools — 40 tasks at its
 * widest in the table above. Like the session cap, this number exists to stop a
 * fork bomb rather than to size normal work, so it sits two orders of magnitude
 * clear of a real build.
 */
const BUILD_TASKS_MAX = 2048

/**
 * NO SWAP FOR A BUILD — the same answer trap 2 reaches for a session, and for a
 * build there is not even a case for the other side.
 *
 * `MemoryMax` alone bounds nothing on a host with swap: the kernel pages the
 * excess out and the machine stops responding without a single OOM kill (this
 * host carries 40 GiB of it). A session at least has an argument for an
 * allowance, since a paged-out idle agent costs nothing. A build is never idle
 * — every page it holds it is about to touch again — so swap buys it nothing
 * and costs the host everything.
 */
const BUILD_SWAP_MAX = 0

export interface ScopeBudgetEnv {
  // The index signature is what lets a bare `process.env` be passed: the named
  // knobs below are documentation and typo protection, not a closed set.
  [key: string]: string | undefined
  /** Absent/empty = use the derived default. `infinity` or `off` = unbounded. */
  PODIUM_SESSION_MEMORY_MAX?: string | undefined
  PODIUM_SESSION_MEMORY_HIGH?: string | undefined
  PODIUM_SESSION_MEMORY_SWAP_MAX?: string | undefined
  PODIUM_SESSION_TASKS_MAX?: string | undefined
  PODIUM_SESSIONS_MEMORY_HIGH?: string | undefined
  /** Per-build scope. `0` is expressible on the swap axis and means "none". */
  PODIUM_BUILD_MEMORY_MAX?: string | undefined
  PODIUM_BUILD_MEMORY_SWAP_MAX?: string | undefined
  PODIUM_BUILD_TASKS_MAX?: string | undefined
  PODIUM_BUILDS_MEMORY_MAX?: string | undefined
  /** Escape hatch: keep the scopes and the slice tree, drop every limit. One
   *  flag for sessions and builds alike — an operator reaching for it is
   *  disabling the policy, not one half of it. */
  PODIUM_NO_SESSION_BUDGET?: string | undefined
}

/**
 * Parse a systemd-style size (`6G`, `512M`, `1048576`, `infinity`).
 *
 * `undefined` means "not configured, use the default"; `null` means "configured
 * as unbounded". The two are different answers and a single `undefined` for
 * both would silently turn an operator's `infinity` into the derived default.
 */
export function parseByteSize(
  value: string | undefined,
  options: { allowZero?: boolean } = {},
): number | null | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const lowered = raw.toLowerCase()
  if (lowered === 'infinity' || lowered === 'off' || lowered === 'none') return null
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]i?b?)?$/.exec(lowered)
  const scale: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }
  const unit = match?.[2]?.[0]
  const bytes = match?.[1]
    ? Number.parseFloat(match[1]) * (unit ? (scale[unit] ?? 1) : 1)
    : Number.NaN
  // `0` IS A VALUE on the axis where it can mean something. "No swap at all"
  // must be expressible; a memory ceiling of zero never is, so only the caller
  // that can mean it opts in.
  if (Number.isFinite(bytes) && (bytes > 0 || (options.allowZero === true && bytes === 0))) {
    return Math.floor(bytes)
  }
  // SAY SO. A typo'd override is indistinguishable from "not configured" and
  // silently restores the derived default — so the operator who raised the cap
  // for a 40 GiB build gets the 16 GiB ceiling and an OOM kill with no evidence
  // that their setting was ignored.
  log.warn('ignoring an unparseable size override; using the derived default', { value: raw })
  return undefined
}

/** Same three-way answer as {@link parseByteSize}, for task counts. */
export function parseTaskCount(value: string | undefined): number | null | undefined {
  const raw = value?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'infinity' || raw === 'off' || raw === 'none') return null
  const parsed = Number.parseInt(raw, 10)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  log.warn('ignoring an unparseable task-count override; using the derived default', { value: raw })
  return undefined
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/**
 * The budget one scope launches with.
 *
 * Derived from host RAM rather than hard-coded: the same daemon runs on an
 * 8 GiB VPS and a 128 GiB workstation, and a fixed number would be either
 * useless or lethal on one of them. Every axis is overridable, because the
 * operator who needs a 40 GiB build is a real person and a budget they cannot
 * raise is a budget they will disable.
 */
export function resolveScopeBudget(
  role: ScopeRole = 'session',
  env: ScopeBudgetEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): ScopeBudget {
  if (env.PODIUM_NO_SESSION_BUDGET) return {}

  const derivedMax =
    role === 'attach'
      ? ATTACH_MEMORY_MAX
      : clamp(
          Math.floor(totalMemoryBytes * SESSION_MEMORY_SHARE),
          SESSION_MEMORY_FLOOR,
          SESSION_MEMORY_CEILING,
        )
  /**
   * A SESSION KNOB CAN ONLY EVER LOWER AN ATTACH BUDGET — including `infinity`.
   *
   * Clamping the max alone was not enough. `…_MEMORY_MAX=infinity` parses to
   * `null`, and letting that through left a client terminal completely
   * unbounded — the opposite of what the clamp beside it claimed. The high band
   * has the same hazard from the other side: one taken from the session knob
   * can sit ABOVE the attach hard cap, which is a warning line the scope can
   * never cross before the kernel kills it.
   */
  const clampToAttach = (configured: number | null | undefined, derived: number): number =>
    configured == null ? derived : Math.min(derived, configured)

  const configuredMax = parseByteSize(env.PODIUM_SESSION_MEMORY_MAX)
  const memoryMaxBytes =
    role === 'attach'
      ? clampToAttach(configuredMax, derivedMax)
      : configuredMax === null
        ? undefined
        : (configuredMax ?? derivedMax)

  /**
   * NO DERIVED HIGH. There is no safe default band below the ceiling: a runaway
   * throttles there indefinitely instead of reaching the kill line (trap 1). An
   * explicit `PODIUM_SESSION_MEMORY_HIGH` is honoured as exactly what it is — a
   * reclaim-only policy the operator chose — and for an attach scope it is
   * clamped under the hard cap so it can never sit above its own limit.
   */
  const configuredHigh = parseByteSize(env.PODIUM_SESSION_MEMORY_HIGH)
  const memoryHighBytes =
    role === 'attach'
      ? memoryMaxBytes === undefined || configuredHigh == null
        ? undefined
        : Math.min(memoryMaxBytes, configuredHigh)
      : (configuredHigh ?? undefined)

  const derivedSwap =
    memoryMaxBytes === undefined ? undefined : Math.floor(memoryMaxBytes * SWAP_FRACTION)
  const configuredSwap = parseByteSize(env.PODIUM_SESSION_MEMORY_SWAP_MAX, { allowZero: true })
  const memorySwapMaxBytes =
    role === 'attach'
      ? derivedSwap === undefined
        ? undefined
        : clampToAttach(configuredSwap, derivedSwap)
      : configuredSwap === null
        ? undefined
        : (configuredSwap ?? derivedSwap)

  const configuredTasks = parseTaskCount(env.PODIUM_SESSION_TASKS_MAX)
  const derivedTasks = role === 'attach' ? ATTACH_TASKS_MAX : SESSION_TASKS_MAX
  const tasksMax =
    role === 'attach'
      ? clampToAttach(configuredTasks, derivedTasks)
      : configuredTasks === null
        ? undefined
        : (configuredTasks ?? derivedTasks)

  return {
    ...(memoryHighBytes !== undefined ? { memoryHighBytes } : {}),
    ...(memoryMaxBytes !== undefined ? { memoryMaxBytes } : {}),
    ...(memorySwapMaxBytes !== undefined ? { memorySwapMaxBytes } : {}),
    ...(tasksMax !== undefined ? { tasksMax } : {}),
  }
}

/** The aggregate throttle for the sessions slice, or `undefined` when off. */
export function resolveSessionsSliceHigh(
  env: ScopeBudgetEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): number | undefined {
  if (env.PODIUM_NO_SESSION_BUDGET) return undefined
  const configured = parseByteSize(env.PODIUM_SESSIONS_MEMORY_HIGH)
  if (configured === null) return undefined
  return configured ?? Math.floor(totalMemoryBytes * SESSIONS_SLICE_SHARE)
}

/**
 * The budget ONE DEVELOPMENT BUILD launches with (POD-2472).
 *
 * A separate resolver rather than a third {@link ScopeRole}, because a build is
 * not a small session — it is a different policy on every axis, and folding it
 * into the session/attach derivation would have made one expression answer
 * three unrelated questions:
 *
 *  - NO `MemoryHigh`, and no knob that could introduce one. Trap 1 above is why
 *    a session has none either, but a build cannot even be given the choice: a
 *    throttled build holds the update lock, blocks the next redeploy, and
 *    reports nothing, so an operator's reclaim-only policy would be a wedge.
 *    A build over its budget must DIE, visibly.
 *  - No swap ({@link BUILD_SWAP_MAX}).
 *  - Its own knobs. An operator who raised the SESSION cap for a big agent did
 *    not thereby ask for bigger builds, and the reverse is just as true.
 */
export function resolveBuildBudget(
  env: ScopeBudgetEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): ScopeBudget {
  if (env.PODIUM_NO_SESSION_BUDGET) return {}

  /**
   * The ceiling and the share, whichever binds first. On this 12 GiB host that
   * is the ceiling; on a 4 GiB VPS it is the share, and a build too big for the
   * box fails fast instead of taking the box with it.
   */
  const sliceMax = resolveBuildsSliceBudget(env, totalMemoryBytes).memoryMaxBytes
  const derivedMax = Math.min(BUILD_MEMORY_CEILING, sliceMax ?? BUILD_MEMORY_CEILING)

  const configuredMax = parseByteSize(env.PODIUM_BUILD_MEMORY_MAX)
  const memoryMaxBytes = configuredMax === null ? undefined : (configuredMax ?? derivedMax)

  const configuredSwap = parseByteSize(env.PODIUM_BUILD_MEMORY_SWAP_MAX, { allowZero: true })
  const memorySwapMaxBytes =
    configuredSwap === null ? undefined : (configuredSwap ?? BUILD_SWAP_MAX)

  const configuredTasks = parseTaskCount(env.PODIUM_BUILD_TASKS_MAX)
  const tasksMax = configuredTasks === null ? undefined : (configuredTasks ?? BUILD_TASKS_MAX)

  return {
    ...(memoryMaxBytes !== undefined ? { memoryMaxBytes } : {}),
    ...(memorySwapMaxBytes !== undefined ? { memorySwapMaxBytes } : {}),
    ...(tasksMax !== undefined ? { tasksMax } : {}),
  }
}

/**
 * The aggregate cap on the instance's BUILDS slice — a `Max`, not a `High`.
 *
 * Per-scope caps alone do not bound the builds: the bundle compile and the two
 * website steps are separate units under separate names, so three of them can
 * be live at once and three times one cap is not a bound. The slice is where
 * that is answered, and it may kill, because killing every live build on the
 * box costs a redeploy and no conversation.
 */
export function resolveBuildsSliceBudget(
  env: ScopeBudgetEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): ScopeBudget {
  if (env.PODIUM_NO_SESSION_BUDGET) return {}
  const configured = parseByteSize(env.PODIUM_BUILDS_MEMORY_MAX)
  if (configured === null) return {}
  const memoryMaxBytes = configured ?? Math.floor(totalMemoryBytes * BUILDS_SLICE_SHARE)
  const configuredSwap = parseByteSize(env.PODIUM_BUILD_MEMORY_SWAP_MAX, { allowZero: true })
  const memorySwapMaxBytes =
    configuredSwap === null ? undefined : (configuredSwap ?? BUILD_SWAP_MAX)
  return {
    memoryMaxBytes,
    ...(memorySwapMaxBytes !== undefined ? { memorySwapMaxBytes } : {}),
  }
}

/**
 * `systemctl --user set-property --runtime` argv for the builds slice.
 *
 * Runtime-only for the same reason as the sessions slice: the tree is
 * transient. Verified on this host that the property applies to a slice with no
 * members yet, materializes for the first scope launched into it, and survives
 * that scope exiting — so the aggregate cap is in force from the first build,
 * not the second.
 */
export function buildsSliceBudgetArgv(slice: string, budget: ScopeBudget): string[] {
  const props: string[] = []
  if (budget.memoryMaxBytes !== undefined) props.push(`MemoryMax=${budget.memoryMaxBytes}`)
  if (budget.memorySwapMaxBytes !== undefined) {
    props.push(`MemorySwapMax=${budget.memorySwapMaxBytes}`)
  }
  return props.length === 0 ? [] : ['--user', 'set-property', '--runtime', slice, ...props]
}

/**
 * `--property=` arguments for a budget, plus the OOM policy that makes the
 * budget survivable.
 *
 * `OOMPolicy=continue` is the load-bearing one: without it a kernel OOM kill
 * inside the scope takes the WHOLE unit down, so one runaway `bun test` would
 * end the agent session hosting it. With it, the kernel kills the offending
 * process and the session stays up to report what happened — verified on this
 * host: the child died with 137, the parent kept running, and the scope stayed
 * active with `memory.events`' `oom_kill` at 1.
 */
export function scopeBudgetProperties(budget: ScopeBudget): string[] {
  const props: string[] = []
  if (budget.memoryHighBytes !== undefined) {
    props.push(`--property=MemoryHigh=${budget.memoryHighBytes}`)
  }
  if (budget.memoryMaxBytes !== undefined)
    props.push(`--property=MemoryMax=${budget.memoryMaxBytes}`)
  if (budget.memorySwapMaxBytes !== undefined) {
    props.push(`--property=MemorySwapMax=${budget.memorySwapMaxBytes}`)
  }
  if (budget.tasksMax !== undefined) props.push(`--property=TasksMax=${budget.tasksMax}`)
  props.push('--property=OOMPolicy=continue')
  return props
}

/** `systemctl --user set-property --runtime` argv for the sessions slice.
 *  Runtime-only: the tree is transient, and a persistent drop-in for a slice
 *  nothing declares would outlive the instance that wanted it. */
export function sliceBudgetArgv(slice: string, highBytes: number): string[] {
  return ['--user', 'set-property', '--runtime', slice, `MemoryHigh=${highBytes}`]
}
