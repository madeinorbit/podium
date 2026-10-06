import { attachSettingsSource } from '@podium/client-graph/settings-source'
import { settingsView } from './settings-views'
import { dedupeSessionsByResume } from '@podium/model'
import type { SessionView } from '@podium/client-core/session-values'
import { createRepositoryUsageSelector, resolveDefaultAgent } from '@podium/client-core/values'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { automationViews } from './automation-views'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import { createColdIndex } from './shared/cold-index'
import type { SettingsOwner } from './settings-source'
import { SETUP_SESSION_SUMMARY_FIELDS } from './settings-schema'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'

const old = '2020-01-01T00:00:00Z', recent = '2026-01-01T00:00:00Z'
const session = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, agentKind: 'codex', cwd: '/foreign', lastActiveAt: old,
  status: 'exited', stoppedAt: old, ...patch,
} } as RowRecord)
function fixture(rows: RowRecord[]) {
  const source = createColdIndex(SCHEMA, { session: SETUP_SESSION_SUMMARY_FIELDS })
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(recent) }, undefined, {
    settings: true, cold: () => source, load: () => undefined, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  const publish = (event: RowSourceEvent) => { source.apply(event); pool.apply(event) }
  return { pool, source, publish }
}

it('keeps first setup demand, named presence, counts and heartbeat updates flat at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const target = session('target', { cwd: '/shown/sub', lastActiveAt: recent }),
      fallback = session('fallback', { cwd: '/shown/sub', lastActiveAt: '2025-01-01T00:00:00Z', agentKind: 'grok' })
    const f = fixture([target, fallback, ...Array.from({ length: 128 * scale }, (_, n) => session(`foreign-${n}`))])
    const rows = vi.spyOn(f.pool, 'row'), ids = vi.spyOn(f.pool.queries, 'ids'),
      roster = vi.spyOn(settingsView(f.pool), 'sessions'), keys = vi.spyOn(f.pool.tables.session, 'keys')
    const view = createPoolProjection(f.pool, pool => ({
      setup: settingsView(pool).setup(['/shown', '/absent']),
      present: settingsView(pool).sessionPresent('target'),
      count: settingsView(pool).sessionCount(),
    })), paint = vi.fn()
    let stop = () => {}
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, action), { pool: f.pool })
    try {
      const first = await measure('setup first demand', () => {
        expect(view.getSnapshot()).toMatchObject({ setup: { defaultAgent: 'codex', pending: 0 }, present: true, count: 2 + 128 * scale })
        expect(view.getSnapshot().setup.usage).toEqual(new Map([['/shown', Date.parse(recent)]]))
        stop = view.subscribe(paint)
      })
      expect(rows).not.toHaveBeenCalled()
      const repeated = await measure('setup repeated demand', () => { view.getSnapshot() })
      const unrelated = await measure('setup unrelated heartbeat', () => f.publish({ type: 'update', rows: [session('foreign-0', { lastActiveAt: '2021-01-01T00:00:00Z' })] }))
      expect(paint).not.toHaveBeenCalled()
      const targetUpdate = await measure('setup target agent change', () => f.publish({ type: 'update', rows: [session('target', {
        cwd: '/shown/sub', lastActiveAt: recent, agentKind: 'claude-code',
      })] }))
      expect(view.getSnapshot().setup.defaultAgent).toBe('claude-code')
      expect(paint).toHaveBeenCalledTimes(1)
      const named = await measure('automation named session', () => expect(automationViews(f.pool).session('target')).toMatchObject({ sessionId: 'target' }))
      const removed = await measure('setup target removed', () => f.publish({ type: 'update', rows: [{ kind: 'session', id: 'target', value: undefined }] }))
      expect(view.getSnapshot()).toMatchObject({ setup: { defaultAgent: 'grok' }, present: false, count: 1 + 128 * scale })
      expect(view.getSnapshot().setup.usage.get('/shown')).toBe(Date.parse('2025-01-01T00:00:00Z'))
      stop(); rows.mockClear(); paint.mockClear()
      const closed = await measure('setup closed', () => f.publish({ type: 'update', rows: [session('fallback', { lastActiveAt: recent })] }))
      expect(rows.mock.calls.every(([entity, id, mode]) => entity === 'session' && id === 'fallback' && mode === 'mark')).toBe(true)
      expect(paint).not.toHaveBeenCalled()
      expect(ids).not.toHaveBeenCalled(); expect(roster).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled()
      return Object.fromEntries(Object.entries({ first, repeated, unrelated, targetUpdate, named, removed, closed }).map(([name, value]) => [name, value.work]))
    } finally { stop(); rows.mockRestore(); ids.mockRestore(); roster.mockRestore(); keys.mockRestore(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('settings addressed work1x4x', JSON.stringify({ first, second }))
  for (const action of Object.keys(first)) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
    expect(second[action]?.[counter]).toBe(first[action]?.[counter])
})

it('preserves source-order defaults, shell/headless usage, archived history and resume winners', () => {
  let rows = [session('first', { cwd: '/shown/sub', lastActiveAt: recent, archived: true }),
    session('tie', { agentKind: 'grok', cwd: '/shown/sub', lastActiveAt: recent }),
    session('headless', { headless: true, cwd: '/shown/wt/child', lastActiveAt: '2028-01-01T00:00:00Z' }),
    session('shell', { agentKind: 'shell', cwd: '/shown', lastActiveAt: '2030-01-01T00:00:00Z' }),
    session('invalid', { cwd: '/invalid', lastActiveAt: 'invalid', headless: true }),
    session('negative', { cwd: '/negative', lastActiveAt: '1960-01-01T00:00:00Z', headless: true }),
    session('twin-old', { cwd: '/twins', lastActiveAt: old, resume: { kind: 'codex.thread', value: 'twin' } }),
    session('twin-new', { cwd: '/twins', lastActiveAt: '2027-01-01T00:00:00Z', resume: { kind: 'codex.thread', value: 'twin' } })]
  const f = fixture(rows)
  const check = () => {
    const effective = dedupeSessionsByResume(rows.map(row => row.value) as unknown as SessionView[])
    const expected = createRepositoryUsageSelector()(effective), paths = [...expected.keys(), '/invalid', '/negative', '/missing']
    const setup = settingsView(f.pool).setup(paths)
    expect(setup.defaultAgent).toBe(resolveDefaultAgent(undefined, effective))
    expect(setup.usage).toEqual(expected)
    expect(settingsView(f.pool).sessionCount()).toBe(effective.length)
    for (const row of rows) expect(settingsView(f.pool).sessionPresent(row.id)).toBe(effective.some(value => value.sessionId === row.id))
  }
  try {
    check()
    rows = rows.map(row => row.id === 'twin-old' ? session(row.id, { cwd: '/twins/moved', lastActiveAt: '2029-01-01T00:00:00Z', resume: { kind: 'codex.thread', value: 'twin' } }) : row)
    f.publish({ type: 'update', rows: [rows.find(row => row.id === 'twin-old')!] }); check()
    rows = rows.filter(row => row.id !== 'twin-old')
    f.publish({ type: 'update', rows: [{ kind: 'session', id: 'twin-old', value: undefined }] }); check()
    rows = [rows[1]!, rows[0]!, ...rows.slice(2)]
    f.publish({ type: 'replace', rows }); check()
    f.publish({ type: 'replace', rows: [] })
    expect(settingsView(f.pool).sessionCount()).toBe(0)
    expect(settingsView(f.pool).setup(['/shown'])).toMatchObject({ usage: new Map(), defaultAgent: 'claude-code' })
  } finally { f.pool.dispose() }
})

it('orders visible automation targets with path maxima and no session catalog at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const target = session('target', { cwd: '/shown/wt/sub', lastActiveAt: recent }),
      other = session('other', { cwd: '/other', lastActiveAt: '2025-01-01T00:00:00Z', agentKind: 'shell' })
    const f = fixture([target, other, ...Array.from({ length: 128 * scale }, (_, n) => session(`foreign-${n}`))])
    const repos = new Map([['shown', { path: '/shown', kind: 'repository', worktrees: [{ path: '/shown/wt' }] }],
      ['other', { path: '/other', kind: 'repository', worktrees: [] }]])
    attachSettingsSource(f.pool, { listIds: (name: string) => name === 'repos' ? [...repos.keys()] : [],
      listRow: (name: string, id: string) => name === 'repos' ? repos.get(id) : undefined,
      readLocal: () => 'sessions', onList: () => () => {}, onLocals: () => () => {},
    } as unknown as SettingsOwner)
    const rows = vi.spyOn(f.pool, 'row'), roster = vi.spyOn(settingsView(f.pool), 'sessions'), ids = vi.spyOn(f.pool.queries, 'ids')
    const view = createPoolProjection(f.pool, pool => automationViews(pool).targets()), paint = vi.fn()
    let stop = () => {}
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, action), { pool: f.pool })
    try {
      expect(rows).not.toHaveBeenCalled()
      const first = await measureWork(async () => {
        insideReader('automation choices first demand', () => {
          expect(view.getSnapshot().pending).toBe(1)
          stop = view.subscribe(paint)
        })
        // Observed settings demand loads the catalog, then its named rows,
        // in separate microtasks. An imperative pre-read warms neither.
        await Promise.resolve()
        await Promise.resolve()
        expect(view.getSnapshot().pending).toBe(0)
        expect(view.getSnapshot().ids.map(id => automationViews(f.pool).target(id)?.value)).toEqual(['/shown', '/other', '__global__'])
      }, { pool: f.pool })
      paint.mockClear()
      const repeated = await measure('automation choices repeated demand', () => { view.getSnapshot() })
      const unrelated = await measure('automation choices unrelated heartbeat', () => f.publish({ type: 'update', rows: [session('foreign-0', { lastActiveAt: '2021-01-01T00:00:00Z' })] }))
      expect(paint).not.toHaveBeenCalled()
      const changed = await measure('automation choices root changed', () => f.publish({ type: 'update', rows: [session('other', { cwd: '/other', agentKind: 'shell', lastActiveAt: '2027-01-01T00:00:00Z' })] }))
      expect(view.getSnapshot().ids.map(id => automationViews(f.pool).target(id)?.value)).toEqual(['/other', '/shown', '__global__'])
      expect(paint).toHaveBeenCalledTimes(1)
      stop(); rows.mockClear(); paint.mockClear()
      const closed = await measure('automation choices closed', () => f.publish({ type: 'update', rows: [session('target', { cwd: '/shown', lastActiveAt: '2028-01-01T00:00:00Z' })] }))
      expect(rows.mock.calls.every(([entity, id, mode]) => entity === 'session' && id === 'target' && mode === 'mark')).toBe(true)
      expect(paint).not.toHaveBeenCalled()
      expect(roster).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled()
      return Object.fromEntries(Object.entries({ first, repeated, unrelated, changed, closed }).map(([name, value]) => [name, value.work]))
    } finally { stop(); view.dispose(); rows.mockRestore(); roster.mockRestore(); ids.mockRestore(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('automation target work1x4x', JSON.stringify({ first, second }))
  for (const action of Object.keys(first)) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
    expect(second[action]?.[counter]).toBe(first[action]?.[counter])
})
