/**
 * THE SUPERVISOR'S EYES: per-session cgroup observation (POD-2413; spec §6).
 *
 * `packages/pty` knows how to read a cgroup; this file knows WHICH cgroup
 * belongs to which session, keeps a recent sample of each, and turns a rise in
 * the kernel's OOM-kill counter into a stated fact. It is the only place in the
 * daemon that polls the kernel for resource truth — the four driver hosts all
 * read their numbers from here, so "how much memory does this session use" has
 * exactly one answer regardless of family.
 *
 * WHY POLLING, AND WHY IT IS CHEAP. cgroup v2 has no OOM notification a
 * non-root process can subscribe to; `memory.events` is a counter, so the
 * supervisor must look. A look is a handful of `readFileSync`s of small
 * procfs-like files per live session, once per {@link POLL_INTERVAL_MS} — the
 * same order of work as the memory breakdown this daemon already computes on
 * demand, and far less than the `/proc` subtree walk it replaces for scoped
 * sessions.
 *
 * WHY A BASELINE, AND WHY IT IS NOT "THE FIRST SAMPLE". The counter is
 * cumulative for the life of the cgroup, so a session ADOPTED after a daemon
 * restart may already carry kills; announcing those would re-emit an
 * `oomKilled` on every restart, and these events are durable-synced. But
 * baselining on first sight is just as wrong in the other direction — a session
 * that OOMs seconds after spawning has its kill swallowed by the very first
 * poll, which is exactly the case an operator most needs told (measured: a
 * scope that died 2.5s in reported nothing under that rule).
 *
 * The cgroup itself settles it. cgroupfs stamps the directory's mtime when the
 * kernel creates it, so a scope OLDER than this observer is one we adopted (its
 * kills are history, baseline = what it carries) and a YOUNGER one started on
 * our watch (baseline = 0, so every kill is news). No windows, no guessing, and
 * correct for an adoption that happens hours after boot.
 *
 * `health()` reports the true total either way: a count is a measurement, while
 * an event is a claim about something happening NOW.
 */

import type { ScopeResources } from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import {
  type CgroupSample,
  cgroupRoot,
  readCgroupSample,
  sessionScopeCgroupPath,
  sliceChainPath,
  userManagerCgroupBase,
} from '@podium/pty'
import { instanceSessionSliceName } from '@podium/runtime/instance'

const log = createLogger('daemon:scope-monitor')

/** How often live sessions are sampled. */
const POLL_INTERVAL_MS = 10_000
/** A sample this fresh answers a `resources()` call without touching the disk. */
const SAMPLE_TTL_MS = 2_000

export interface ScopeMonitorSubject {
  sessionId: SessionId
  scopeUnit?: string | undefined
  /** A durable label or process key, for the `/proc` fallback attribution. */
  label?: string | undefined
  pid?: number | undefined
}

export interface ScopeMonitorDeps {
  /** Every session this machine currently believes it hosts. */
  subjects(): readonly ScopeMonitorSubject[]
  /** Whole-subtree RSS where there is no cgroup to read (macOS, unscoped spawn,
   *  a scope already collected). Today's `/proc` attribution, unchanged. */
  fallbackMemoryBytes(input: {
    sessionId: SessionId
    label: string
    pid?: number
  }): number | undefined
  /** A NEW kernel OOM kill inside a session's scope. */
  onOomKill(input: { sessionId: SessionId; scopeUnit?: string; kills: number }): void
  now?(): number
  uid?(): number | undefined
  intervalMs?: number
}

export interface ScopeMonitor {
  /** Resource truth for one session, fresh enough to answer `health()`. */
  resources(subject: ScopeMonitorSubject): ScopeResources | undefined
  /**
   * What every session on this instance is using, against the aggregate
   * throttle their slice carries.
   *
   * ATTRIBUTABLE PRESSURE, which host-wide `MemAvailable` is not: a browser and
   * a fleet of runaway agents move the host number identically, and only one of
   * them is fixed by parking a session. `undefined` where there is no slice to
   * read — no cgroups, or no session has ever been scoped on this machine.
   */
  sessionsMemory(): { currentBytes: number; highBytes: number } | undefined
  /** One sampling pass. Exposed for tests and for callers that want a reading
   *  right now (the reclaim policy) rather than at the next tick. */
  poll(): void
  start(): void
  dispose(): void
}

interface Tracked {
  path?: string
  sample?: CgroupSample
  at: number
  /** Kills that predate this observer — see the baseline note in the header. */
  baseline?: number
  reported: number
}

export function createScopeMonitor(deps: ScopeMonitorDeps): ScopeMonitor {
  const now = deps.now ?? (() => Date.now())
  const uid = deps.uid ?? (() => process.getuid?.())
  const tracked = new Map<SessionId, Tracked>()
  const slice = instanceSessionSliceName()
  /** When this observer's watch began — the line between adopted and ours. */
  const observingSince = now()
  let timer: ReturnType<typeof setInterval> | undefined

  function entry(sessionId: SessionId): Tracked {
    const existing = tracked.get(sessionId)
    if (existing) return existing
    const fresh: Tracked = { at: 0, reported: 0 }
    tracked.set(sessionId, fresh)
    return fresh
  }

  /**
   * Locate (and remember) a session's cgroup. Re-derived when the remembered
   * path stops answering: a session that respawned under the same label has a
   * NEW cgroup at the same place, and a stale path would report the dead one's
   * final numbers forever.
   */
  function pathFor(subject: ScopeMonitorSubject, state: Tracked): string | undefined {
    const currentUid = uid()
    if (!subject.scopeUnit || currentUid === undefined) return undefined
    if (state.path) return state.path
    const path = sessionScopeCgroupPath(subject.scopeUnit, { uid: currentUid, slice })
    if (path) state.path = path
    return path
  }

  function sample(subject: ScopeMonitorSubject): CgroupSample | undefined {
    const state = entry(subject.sessionId)
    const path = pathFor(subject, state)
    const read = path ? readCgroupSample(path) : undefined
    if (!read && path) {
      // The scope was collected, or the session respawned into a new one. Drop
      // the remembered path so the next look re-derives it.
      state.path = undefined
    }
    state.sample = read
    state.at = now()
    if (read) {
      state.baseline ??=
        read.createdAtMs !== undefined && read.createdAtMs < observingSince ? read.oomKills : 0
    }
    return read
  }

  function toResources(
    subject: ScopeMonitorSubject,
    cgroup: CgroupSample | undefined,
  ): ScopeResources | undefined {
    const fallback =
      cgroup?.memoryBytes === undefined
        ? deps.fallbackMemoryBytes({
            sessionId: subject.sessionId,
            label: subject.label ?? '',
            ...(subject.pid !== undefined ? { pid: subject.pid } : {}),
          })
        : undefined
    const memoryBytes = cgroup?.memoryBytes ?? fallback
    if (!cgroup && memoryBytes === undefined) return undefined
    return {
      ...(memoryBytes !== undefined ? { memoryBytes } : {}),
      ...(cgroup?.peakMemoryBytes !== undefined ? { peakMemoryBytes: cgroup.peakMemoryBytes } : {}),
      ...(cgroup?.tasks !== undefined ? { tasks: cgroup.tasks } : {}),
      ...(cgroup?.tasksMax !== undefined ? { tasksMax: cgroup.tasksMax } : {}),
      ...(cgroup?.memoryHighBytes !== undefined ? { memoryHighBytes: cgroup.memoryHighBytes } : {}),
      ...(cgroup?.memoryMaxBytes !== undefined ? { memoryMaxBytes: cgroup.memoryMaxBytes } : {}),
      // A cgroup answers the counter; without one the honest answer is still 0,
      // because no kill has been OBSERVED — and the absent `memoryMaxBytes`
      // beside it says why nobody could have observed one.
      oomKills: cgroup?.oomKills ?? 0,
      ...(cgroup?.throttleEvents !== undefined ? { throttleEvents: cgroup.throttleEvents } : {}),
      ...(subject.scopeUnit ? { scopeUnit: subject.scopeUnit } : {}),
    }
  }

  function poll(): void {
    const live = new Set<SessionId>()
    for (const subject of deps.subjects()) {
      live.add(subject.sessionId)
      const state = entry(subject.sessionId)
      const cgroup = sample(subject)
      if (!cgroup) continue
      const baseline = state.baseline ?? cgroup.oomKills
      const fresh = cgroup.oomKills - Math.max(baseline, state.reported)
      if (fresh <= 0) continue
      state.reported = cgroup.oomKills
      log.warn('the kernel OOM-killed a process inside a session scope', {
        sessionId: subject.sessionId,
        scopeUnit: subject.scopeUnit,
        kills: cgroup.oomKills,
        memoryMaxBytes: cgroup.memoryMaxBytes,
      })
      deps.onOomKill({
        sessionId: subject.sessionId,
        ...(subject.scopeUnit ? { scopeUnit: subject.scopeUnit } : {}),
        kills: fresh,
      })
    }
    for (const sessionId of [...tracked.keys()]) {
      if (!live.has(sessionId)) tracked.delete(sessionId)
    }
  }

  return {
    sessionsMemory() {
      const currentUid = uid()
      if (currentUid === undefined) return undefined
      const path = `${cgroupRoot()}${userManagerCgroupBase(currentUid)}/${sliceChainPath(slice)}`
      const sample = readCgroupSample(path)
      // BOTH NUMBERS OR NEITHER. A `memory.current` without the `MemoryHigh` it
      // is measured against is a number with no scale, and a consumer that
      // compared it to something else would be inventing the threshold.
      if (sample?.memoryBytes === undefined || sample.memoryHighBytes === undefined) {
        return undefined
      }
      return { currentBytes: sample.memoryBytes, highBytes: sample.memoryHighBytes }
    },
    resources(subject) {
      const state = entry(subject.sessionId)
      const fresh = state.at !== 0 && now() - state.at < SAMPLE_TTL_MS
      return toResources(subject, fresh ? state.sample : sample(subject))
    },
    poll,
    start() {
      if (timer) return
      timer = setInterval(poll, deps.intervalMs ?? POLL_INTERVAL_MS)
      timer.unref?.()
    },
    dispose() {
      if (timer) clearInterval(timer)
      timer = undefined
      tracked.clear()
    },
  }
}
