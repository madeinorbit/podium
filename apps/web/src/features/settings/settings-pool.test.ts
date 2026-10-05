import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dedupeSessionsByResume } from '@podium/model'
import { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { checkSettings } from '@podium/client-graph/diagnostics/settings-check'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { SessionView } from '@podium/client-core/session-values'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { SliceSession } from '@podium/client-graph/shared/slice-types'


const disposals: (() => void)[] = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose() })
const stamp = '2020-01-01T00:00:00.000Z'
const session = (id: string, agent: string, cold = false): SliceSession => ({
  sessionId: id, agentKind: agent, cwd: '/project/subdir', lastActiveAt: stamp,
  status: cold ? 'exited' : 'live', ...(cold ? { stoppedAt: stamp, agentState: { phase: 'ended', since: stamp } } : {}),
})
function fixture(sessions: SliceSession[] = []) {
  const values = new Map<string, string>()
  const uiListeners = new Set<(keys: ReadonlySet<string>) => void>(), listeners = new Set<() => void>()
  const ui = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string | null) => { if (value === null) values.delete(key); else values.set(key, value); for (const wake of uiListeners) wake(new Set([key])) },
    subscribe: (wake: (keys: ReadonlySet<string>) => void) => { uiListeners.add(wake); return () => { uiListeners.delete(wake) } },
  } as RoutedUiState
  let state = { machines: [{ id: 'host', name: 'Host' }], repos: [{ path: '/project', kind: 'repository', worktrees: [] }], settingsTab: 'accounts',
    sessions: dedupeSessionsByResume(sessions as unknown as SessionView[]) }
  const read = vi.fn(() => state as object)
  const owner = withKeyedInputs({ getSnapshot: read, ui, subscribe: (wake: () => void) => { listeners.add(wake); return () => { listeners.delete(wake) } } })
  const feed = new Map(sessions.map((row) => [row.sessionId, row]))
  const load = vi.fn((_entity: string, id: string) => feed.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-02') }, undefined,
    { settings: true, load, schedule: () => () => {} })
  pool.attachSettings(owner)
  pool.attachPreferences(ui)
  pool.apply({ type: 'replace', rows: sessions.map((row) => ({ kind: 'session' as const, id: row.sessionId, value: row })) })
  disposals.push(() => pool.dispose())
  return { pool, read, load, owner, feed, values, uiListeners, listeners,
    state: () => state,
    publish(patch: Partial<typeof state>) { state = { ...state, ...patch }; for (const wake of listeners) wake() },
  }
}

describe('declared settings readers', () => {
  it('keeps borrowed row identity and stays quiet for unchanged settings publications', () => {
    const row = session('hot', 'codex'), { pool } = fixture([row])
    expect(pool.row('session', row.sessionId)).toBe(row)
    const changed = vi.spyOn(pool.tables.session, 'set')
    disposals.push(() => changed.mockRestore())
    const setup = pool.row('setupSession', row.sessionId)
    expect(Object.isFrozen(setup)).toBe(true)
    expect(pool.row('setupSession', row.sessionId)).toBe(setup)
    for (const type of ['update', 'replace'] as const) {
      pool.apply({ type, rows: [{ kind: 'session', id: row.sessionId, value: row }] })
      expect(pool.row('session', row.sessionId)).toBe(row)
      expect(pool.row('setupSession', row.sessionId)).toBe(setup)
    }
    expect(changed).not.toHaveBeenCalled()
  })

  it('updates source-order ties without replacing full rows or copying cold payloads', () => {
    let payloadReads = 0
    const cold = { ...session('cold', 'codex', true), get privatePayload() { payloadReads++; return 'large payload' } }
    const hot = session('hot', 'claude-code'), { pool, load } = fixture([cold, hot])
    const view = createPoolProjection(pool, current => current.settingsViews.setup().defaultAgent)
    const wake = vi.fn(), stop = view.subscribe(wake)
    disposals.push(stop)
    expect(view.getSnapshot()).toBe('codex')
    const first = pool.row('setupSession', 'cold')
    expect(first).toMatchObject({ setupOrder: 1 })
    pool.apply({ type: 'replace', rows: [hot, cold].map(value => ({ kind: 'session' as const, id: value.sessionId, value })) })
    expect(wake).toHaveBeenCalledTimes(1)
    expect(view.getSnapshot()).toBe('claude-code')
    expect(pool.row('session', 'hot')).toBe(hot)
    expect(pool.row('setupSession', 'cold')).toMatchObject({ setupOrder: 2 })
    expect(pool.row('setupSession', 'cold')).not.toBe(first)
    expect(first).toMatchObject({ setupOrder: 1 })
    expect(pool.row('setupSession', 'cold')).not.toHaveProperty('privatePayload')
    expect(payloadReads).toBe(0)
    expect(load).not.toHaveBeenCalled()
    expect(pool.tables.session.has('cold')).toBe(false)
  })

  it('batches the catalog and window, returns loading first, and invalidates only changed rows', async () => {
    const { pool, read, publish } = fixture()
    expect(pool.row('settingsCatalog', 'catalog')).toBe(LOADING)
    expect(pool.row('settingsWindow', 'window')).toBe(LOADING)
    expect(pool.row('settingsMachine', 'host')).toBe(LOADING)
    expect(read).not.toHaveBeenCalled()
    await Promise.resolve()
    // One batch; it reads the catalog and window by key (POD-5433).
    expect(read).toHaveBeenCalled()
    expect(pool.row('settingsWindow', 'window')).toEqual({ settingsTab: 'accounts' })
    expect(pool.row('settingsMachine', 'missing')).toBeUndefined()
    const view = createPoolProjection(pool, (current) => current.row('settingsMachine', 'host'))
    const wake = vi.fn(), stop = view.subscribe(wake)
    disposals.push(stop)
    publish({ settingsTab: 'updates' }); await Promise.resolve()
    expect(wake).not.toHaveBeenCalled()
    publish({ machines: [{ id: 'host', name: 'Renamed' }] }); await Promise.resolve()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(view.getSnapshot()).toMatchObject({ name: 'Renamed' })
    publish({ machines: [] }); await Promise.resolve()
    expect(pool.row('settingsMachine', 'host')).toBeUndefined()
    expect(pool.row('settingsCatalog', 'catalog')).toMatchObject({ machines: [] })
  })

  it('preserves default-agent ties across hot and cold summaries, updates and hydration', () => {
    const { pool, load, feed } = fixture([session('z-cold', 'codex', true), session('a-hot', 'claude-code')])
    expect(pool.residency?.isCold('session', 'z-cold')).toBe(true)
    expect(pool.settingsViews.setup().defaultAgent).toBe('codex')
    expect(load).not.toHaveBeenCalled()
    expect(pool.row('setupSession', 'z-cold')).not.toHaveProperty('title')
    const next = { ...feed.get('z-cold')!, title: 'not a summary field' }
    feed.set('z-cold', next)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'z-cold', value: next }] })
    expect(pool.settingsViews.setup().defaultAgent).toBe('codex')
    expect(pool.row('session', 'z-cold')).toBe(LOADING)
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(pool.settingsViews.setup().defaultAgent).toBe('codex')
  })

  it('compares catalog, tab, resume twins, usage, agent and demanded preferences with no differences', async () => {
    const a = session('older', 'codex', true), b = { ...session('newer', 'claude-code', true), lastActiveAt: '2021-01-01T00:00:00.000Z' }
    a.resume = b.resume = { kind: 'codex.thread', value: 'synthetic-twin' }
    const f = fixture([a, b, session('shell', 'shell'), { ...session('headless', 'codex'), headless: true }])
    f.owner.ui.set('podium.sounds.enabled', 'false')
    expect(f.pool.row('preference', 'podium.sounds.enabled')).toBe(LOADING)
    expect(checkSettings(f.pool, f.owner as unknown as Parameters<typeof checkSettings>[1]).pending).toBeGreaterThan(0)
    await Promise.resolve()
    const result = checkSettings(f.pool, f.owner as unknown as Parameters<typeof checkSettings>[1])
    expect(result).toMatchObject({ differences: 0, pending: 0, first: null })
    expect(result.positions).toBeGreaterThan(3)
    expect(f.load).not.toHaveBeenCalled()
    expect(f.pool.settingsViews.sessionPresent('older')).toBe(false)
    expect(f.pool.settingsViews.sessionPresent('newer')).toBe(true)
    f.publish({ settingsTab: 'updates', repos: [], machines: [] })
    f.owner.ui.set('podium.sounds.enabled', 'true')
    await Promise.resolve()
    expect(checkSettings(f.pool, f.owner as unknown as Parameters<typeof checkSettings>[1])).toMatchObject({ differences: 0, pending: 0 })
  })

  it('detaches the existing owners and refuses stale reads and queued loads after disposal', async () => {
    const f = fixture()
    f.pool.row('settingsCatalog', 'catalog')
    f.pool.row('preference', 'podium.sounds.enabled')
    expect(f.listeners.size).toBe(1)
    expect(f.uiListeners.size).toBe(1)
    f.pool.dispose()
    expect(f.listeners.size).toBe(0)
    expect(f.uiListeners.size).toBe(0)
    await Promise.resolve()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.pool.row('settingsCatalog', 'catalog')).toBe(LOADING)
    expect(f.pool.row('preference', 'podium.sounds.enabled')).toBe(LOADING)
  })
})
