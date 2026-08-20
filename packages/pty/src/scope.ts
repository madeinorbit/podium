/**
 * SESSION RESOURCE SCOPES: the slice tree, the budgets, and the argv that
 * applies them (POD-2413; agent-runtime spec §6).
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
 * └─ podium-sessions.slice                      MemoryHigh= (aggregate throttle)
 *    ├─ podium-<sessionId>.scope                MemoryHigh/Max, TasksMax, OOMPolicy=continue
 *    └─ podium-oc-attach-<sessionId>.scope      a client TUI, reclaimed FIRST
 * ```
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
  /** Escape hatch: keep the scopes and the slice tree, drop every limit. */
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
