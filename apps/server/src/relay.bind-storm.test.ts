import type { ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Boot-storm regression (the redeploy watchdog-kill incident): a daemon reattach
// replays one `bind` per surviving session. Pre-fix, EVERY bind ran the full
// broadcast pipeline, whose issue rebuild called listSessions() per issue and
// machineName() -> store.listMachines() (a fresh SQLite prepare+all) per session —
// ~15.8k SQL round trips per bind, x66 binds ≈ 21-27s of CPU inside the 30s
// systemd watchdog window. These tests pin all three fixes:
//   1. machine names come from the registry cache (zero SQL on the hot path),
//   2. multi-issue serialization computes the session list once per pass,
//   3. the broadcast pipeline coalesces a bind burst into ~2 runs, not one per bind.
describe('bind-storm regression', () => {
  const G = { cols: 80, rows: 24 }
  const bind = (sessionId: string, cwd: string) =>
    ({ type: 'bind', sessionId, cmd: 'sh', cwd, agentKind: 'shell', geometry: G }) as const

  function makeStorm(opts: { sessions: number; issues: number }) {
    const store = new SessionStore(':memory:')
    store.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
    store.upsertMachine({ id: 'm2', name: 'two', hostname: 'two', tokenHash: 'y' })
    const registry = new SessionRegistry(store)
    registry.attachDaemon('m1', () => {})
    registry.attachDaemon('m2', () => {})
    for (let i = 0; i < opts.issues; i++) {
      registry.issues.create({ repoPath: '/repo', title: `issue ${i}`, startNow: false })
    }
    const bound: { sessionId: string; cwd: string; machineId: string }[] = []
    for (let i = 0; i < opts.sessions; i++) {
      const machineId = i % 2 ? 'm2' : 'm1'
      const cwd = `/repo/w${i}`
      const { sessionId } = registry.createSession({ agentKind: 'shell', cwd, machineId })
      bound.push({ sessionId, cwd, machineId })
    }
    // Settle setup: run any coalesced broadcast so the storm below starts clean.
    registry.flushBroadcasts()
    const inbox: ServerMessage[] = []
    registry.attachClient((m) => inbox.push(m))
    inbox.length = 0
    return { registry, store, bound, inbox }
  }

  it('a 50-bind storm stays off SQLite for machine names and coalesces the pipeline', () => {
    const { registry, store, bound, inbox } = makeStorm({ sessions: 50, issues: 30 })
    const listMachines = vi.spyOn(store, 'listMachines')
    const listSessions = vi.spyOn(registry, 'listSessions')

    for (const s of bound) registry.onDaemonMessageFrom(s.machineId, bind(s.sessionId, s.cwd))
    registry.flushBroadcasts()

    // (c) Pipeline runs ≪ bind count: leading run + one coalesced trailing flush.
    const pipelineRuns = inbox.filter((m) => m.type === 'sessionsChanged').length
    expect(pipelineRuns).toBeGreaterThanOrEqual(1)
    expect(pipelineRuns).toBeLessThanOrEqual(3)
    expect(inbox.filter((m) => m.type === 'issuesChanged').length).toBeLessThanOrEqual(3)

    // (a) Machine names never hit SQLite during the storm (cache built in setup,
    // nothing invalidated it). Pre-fix this was issues x sessions x binds calls.
    expect(listMachines).toHaveBeenCalledTimes(0)

    // (b) The session list is computed once per pipeline stage, not per issue:
    // each run costs 1 (sessions broadcast) + 1 (allWire hoist) listSessions calls.
    expect(listSessions.mock.calls.length).toBeLessThanOrEqual(2 * pipelineRuns)

    // Coalescing must not lose the final state: the last broadcast shows every
    // session live, exactly as 50 synchronous pipeline runs would have.
    const last = inbox.filter((m) => m.type === 'sessionsChanged').at(-1)
    if (last?.type !== 'sessionsChanged') throw new Error('expected sessionsChanged')
    expect(last.sessions).toHaveLength(50)
    expect(last.sessions.every((s) => s.status === 'live')).toBe(true)
    expect(new Set(last.sessions.map((s) => s.machineName))).toEqual(new Set(['one', 'two']))
    registry.dispose()
  })

  it('the coalesced trailing broadcast fires on its own next tick (no flush needed)', async () => {
    const { registry, bound, inbox } = makeStorm({ sessions: 3, issues: 1 })
    for (const s of bound) registry.onDaemonMessageFrom(s.machineId, bind(s.sessionId, s.cwd))
    // Leading run only so far — the follow-ups are pending on the cooldown timer.
    await new Promise((r) => setTimeout(r, 10))
    const last = inbox.filter((m) => m.type === 'sessionsChanged').at(-1)
    if (last?.type !== 'sessionsChanged') throw new Error('expected sessionsChanged')
    expect(last.sessions.filter((s) => s.status === 'live')).toHaveLength(3)
    registry.dispose()
  })

  it('a machine rename invalidates the cache: the next broadcast shows the new name', () => {
    const { registry, bound, inbox } = makeStorm({ sessions: 2, issues: 0 })
    for (const s of bound) registry.onDaemonMessageFrom(s.machineId, bind(s.sessionId, s.cwd))
    registry.flushBroadcasts()
    registry.renameMachine('m1', 'renamed-one')
    registry.flushBroadcasts()
    const last = inbox.filter((m) => m.type === 'sessionsChanged').at(-1)
    if (last?.type !== 'sessionsChanged') throw new Error('expected sessionsChanged')
    expect(last.sessions.find((s) => s.machineId === 'm1')?.machineName).toBe('renamed-one')
    expect(registry.listMachines().find((m) => m.id === 'm1')?.name).toBe('renamed-one')
    registry.dispose()
  })
})
