import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createScopeMonitor, type ScopeMonitorSubject } from './scope-monitor'

/**
 * A uid this host cannot be running as, so the path derivation always takes the
 * logind-layout fallback and the fixture below is where it looks — on Linux, on
 * macOS, and in CI alike.
 */
const UID = 4242
/** The moment the fixture scope's cgroup was "created" — every test places the
 *  observer before or after it deliberately, because that ordering is what
 *  separates a session we started from one we adopted. */
const SCOPE_CREATED_MS = Date.parse('2026-01-01T00:00:00.000Z')
const SESSION = asSessionId('11111111-2222-3333-4444-555555555555')
const UNIT = 'podium-s1.scope'

let root: string
let scope: string
let previousRoot: string | undefined

function writeScope(files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(scope, name), body)
  // Re-stamp AFTER writing: a tmpfs bumps a directory's mtime when a file is
  // added to it, while cgroupfs sets it once at creation and never again. The
  // fixture has to behave like the thing it stands in for.
  utimesSync(scope, SCOPE_CREATED_MS / 1000, SCOPE_CREATED_MS / 1000)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-scope-monitor-'))
  scope = join(
    root,
    `user.slice/user-${UID}.slice/user@${UID}.service/podium.slice/podium-sessions.slice/${UNIT}`,
  )
  mkdirSync(scope, { recursive: true })
  utimesSync(scope, SCOPE_CREATED_MS / 1000, SCOPE_CREATED_MS / 1000)
  previousRoot = process.env.PODIUM_CGROUP_ROOT
  process.env.PODIUM_CGROUP_ROOT = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.PODIUM_CGROUP_ROOT
  else process.env.PODIUM_CGROUP_ROOT = previousRoot
  rmSync(root, { recursive: true, force: true })
})

function monitorFor(
  subject: Partial<ScopeMonitorSubject> = {},
  options: { fallbackBytes?: number; watchingSince?: number } = {},
): {
  monitor: ReturnType<typeof createScopeMonitor>
  kills: { sessionId: SessionId; kills: number }[]
  clock: { ms: number }
} {
  const kills: { sessionId: SessionId; kills: number }[] = []
  // Watching since BEFORE the scope existed = a session this supervisor
  // started. `watchingSince` after it = one it adopted.
  const clock = { ms: options.watchingSince ?? SCOPE_CREATED_MS - 1_000 }
  const monitor = createScopeMonitor({
    subjects: () => [{ sessionId: SESSION, scopeUnit: UNIT, label: 'podium-s1', ...subject }],
    fallbackMemoryBytes: () => options.fallbackBytes,
    onOomKill: ({ sessionId, kills: count }) => kills.push({ sessionId, kills: count }),
    now: () => clock.ms,
    uid: () => UID,
  })
  return { monitor, kills, clock }
}

describe('the scope monitor', () => {
  it('reports what the cgroup says, not a placeholder', () => {
    writeScope({
      'memory.events': 'high 4\noom_kill 0\n',
      'memory.current': '5242880\n',
      'memory.max': '268435456\n',
      'pids.current': '9\n',
    })
    const { monitor } = monitorFor()
    expect(monitor.resources({ sessionId: SESSION, scopeUnit: UNIT })).toEqual({
      memoryBytes: 5242880,
      tasks: 9,
      memoryMaxBytes: 268435456,
      oomKills: 0,
      throttleEvents: 4,
      scopeUnit: UNIT,
    })
  })

  it('states a NEW kernel kill exactly once', () => {
    writeScope({ 'memory.events': 'oom_kill 0\n' })
    const { monitor, kills } = monitorFor()
    monitor.poll()
    expect(kills).toEqual([])

    writeScope({ 'memory.events': 'oom_kill 1\n' })
    monitor.poll()
    expect(kills).toEqual([{ sessionId: SESSION, kills: 1 }])

    // The counter is CUMULATIVE, so a second look at the same value must not
    // re-announce it — these events are durable-synced.
    monitor.poll()
    expect(kills).toHaveLength(1)
  })

  it('states a kill that happens before the first poll of a session we started', () => {
    // The failure this pins was MEASURED: a scope that OOM-killed 2.5s after
    // spawn had its kill swallowed as a "baseline" and nothing was ever said.
    // A scope younger than the observer has no history to baseline.
    writeScope({ 'memory.events': 'oom_kill 1\n' })
    const { monitor, kills } = monitorFor()
    monitor.poll()
    expect(kills).toEqual([{ sessionId: SESSION, kills: 1 }])
  })

  it('does not re-announce the kills an adopted session already carried', () => {
    // A supervisor restart re-discovers a session whose cgroup has been alive
    // for hours. Reporting its history as news would emit an `oomKilled` on
    // every daemon restart, forever — and these events are durable-synced.
    writeScope({ 'memory.events': 'oom_kill 2\n' })
    const { monitor, kills } = monitorFor({}, { watchingSince: SCOPE_CREATED_MS + 60_000 })
    monitor.poll()
    expect(kills).toEqual([])
    // The count is still the truth for `health()` — a baseline suppresses the
    // EVENT, never the measurement.
    expect(monitor.resources({ sessionId: SESSION, scopeUnit: UNIT })?.oomKills).toBe(2)

    writeScope({ 'memory.events': 'oom_kill 3\n' })
    monitor.poll()
    expect(kills).toEqual([{ sessionId: SESSION, kills: 1 }])
  })

  it('falls back to process attribution where there is no cgroup to read', () => {
    const { monitor } = monitorFor({ scopeUnit: undefined }, { fallbackBytes: 4096 })
    expect(monitor.resources({ sessionId: SESSION })).toEqual({ memoryBytes: 4096, oomKills: 0 })
  })

  it('answers nothing at all when neither source knows the session', () => {
    // Not `{ memoryBytes: 0, oomKills: 0 }`: a session using no memory and never
    // OOM-killed is a claim, and "we could not look" is the fact.
    const { monitor } = monitorFor({ scopeUnit: undefined })
    expect(monitor.resources({ sessionId: SESSION })).toBeUndefined()
  })

  it('re-derives the path when a scope is collected and recreated', () => {
    writeScope({ 'memory.events': 'oom_kill 0\n', 'memory.current': '1\n' })
    const { monitor, clock } = monitorFor()
    expect(monitor.resources({ sessionId: SESSION, scopeUnit: UNIT })?.memoryBytes).toBe(1)

    rmSync(scope, { recursive: true, force: true })
    clock.ms += 10_000
    expect(monitor.resources({ sessionId: SESSION, scopeUnit: UNIT })).toBeUndefined()

    // A respawn under the same label is a NEW cgroup at the same place; a
    // remembered path would keep reporting the dead one's final numbers.
    mkdirSync(scope, { recursive: true })
    writeScope({ 'memory.events': 'oom_kill 0\n', 'memory.current': '2\n' })
    clock.ms += 10_000
    expect(monitor.resources({ sessionId: SESSION, scopeUnit: UNIT })?.memoryBytes).toBe(2)
  })

  it('reads the sessions slice as attributable pressure, or nothing', () => {
    const sliceDir = join(
      root,
      `user.slice/user-${UID}.slice/user@${UID}.service/podium.slice/podium-sessions.slice`,
    )
    const { monitor } = monitorFor()
    // Without a `MemoryHigh` there is no scale, and a bare `memory.current`
    // would invite the consumer to invent a threshold.
    writeFileSync(join(sliceDir, 'memory.events'), 'oom_kill 0\n')
    writeFileSync(join(sliceDir, 'memory.current'), '900\n')
    expect(monitor.sessionsMemory()).toBeUndefined()

    writeFileSync(join(sliceDir, 'memory.high'), '1000\n')
    expect(monitor.sessionsMemory()).toEqual({ currentBytes: 900, highBytes: 1000 })
  })

  it('forgets a session that is no longer hosted here', () => {
    writeScope({ 'memory.events': 'oom_kill 1\n' })
    const kills: SessionId[] = []
    let subjects: readonly ScopeMonitorSubject[] = [{ sessionId: SESSION, scopeUnit: UNIT }]
    const monitor = createScopeMonitor({
      subjects: () => subjects,
      fallbackMemoryBytes: () => undefined,
      onOomKill: ({ sessionId }) => kills.push(sessionId),
      uid: () => UID,
    })
    monitor.poll()
    subjects = []
    monitor.poll()
    // Re-registered later (a resume), its baseline is taken fresh — the point of
    // the drop is that nothing accumulates for the daemon's life.
    subjects = [{ sessionId: SESSION, scopeUnit: UNIT }]
    monitor.poll()
    expect(kills).toEqual([])
  })
})
