import type { SessionView } from '@podium/client-core/session-values'
import { dedupeSessionsByResume } from '@podium/model'
import { autorun } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { MobxPool } from './pool'
import { SETUP_SESSION_SUMMARY_FIELDS } from './settings-schema'
import { settingsView } from './settings-views'
import { SHELL_SUMMARIES } from './shell-schema'
import { shellViews } from './shell-views'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord } from './shared/source'
import { LOADING } from './worklist/rollup'

const stamp = '2026-01-01T00:00:00Z'
const fields = [...new Set([...SHELL_SUMMARIES.session, ...SETUP_SESSION_SUMMARY_FIELDS])]
function session(id: string, patch: object = {}): RowRecord {
  return { kind: 'session', id, value: {
    sessionId: id, agentKind: 'codex', cwd: '/shown/sub', lastActiveAt: stamp,
    createdAt: stamp, stoppedAt: stamp, status: 'exited', headless: false,
    name: id, title: id, archived: false, ...patch,
  } } as RowRecord
}
function fixture(initial: RowRecord[]) {
  const rows = new Map(initial.map(row => [row.id, row]))
  const source = createColdIndex(SCHEMA, { session: fields })
  source.apply({ type: 'replace', rows: initial })
  const load = vi.fn((_entity: string, id: string) => rows.get(id)?.value)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-01T00:00:00Z') }, undefined, {
    settings: true, summaries: { session: fields }, cold: () => source,
    load, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: initial })
  return {
    pool, source, rows, load,
    update(id: string, patch?: object) {
      const row = patch ? { ...rows.get(id)!, value: { ...rows.get(id)!.value, ...patch } } : { kind: 'session', id, value: undefined }
      if (patch) rows.set(id, row as RowRecord)
      else rows.delete(id)
      const event = { type: 'update', rows: [row] } as const
      source.apply(event as never); pool.apply(event as never)
    },
    replace(next: RowRecord[]) {
      rows.clear()
      for (const row of next) rows.set(row.id, row)
      const event = { type: 'replace', rows: next } as const
      source.apply(event); pool.apply(event)
    },
  }
}
type SettingsSummary = ReturnType<ReturnType<typeof settingsView>['sessions']>

it('keeps observed summary update work bounded at 1x/4x and preserves unchanged identities', async () => {
  async function measured(scale: 1 | 4) {
    const f = fixture([session('target'), ...Array.from({ length: 128 * scale }, (_, n) => session(`history-${n}`))])
    let shell: SessionView[] = [], settings: SettingsSummary = { rows: [], pending: 0 },
      setup: ReturnType<ReturnType<typeof settingsView>['setup']> | undefined
    const read = vi.fn(() => {
      const value = shellViews(f.pool).sessions()
      if (value && value !== LOADING) shell = value
      settings = settingsView(f.pool).sessions()
      setup = settingsView(f.pool).setup(['/shown'])
    })
    const stop = autorun(read), row = vi.spyOn(f.pool, 'row'), ids = vi.spyOn(f.pool.queries, 'ids')
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, action), { pool: f.pool })
    const oldShell = shell, oldSettings = settings, oldSetup = setup
    const unchangedShell = shell.find(value => value.sessionId === 'history-0')
    const unchangedSetup = settings.rows.find(value => value.sessionId === 'history-0')
    try {
      row.mockClear(); ids.mockClear(); read.mockClear()
      const ignored = await measure('summaries ignored status payload', () => f.update('target', {
        agentState: { phase: 'working', since: stamp }, unread: true, cpuPercent: 30,
      }))
      expect(read).not.toHaveBeenCalled()
      expect(shell).toBe(oldShell); expect(settings).toBe(oldSettings); expect(setup).toBe(oldSetup)
      const status = await measure('summaries material status', () => f.update('target', { status: 'hibernated' }))
      expect(shell.find(value => value.sessionId === 'target')?.status).toBe('hibernated')
      expect(settings.rows.find(value => value.sessionId === 'target')?.status).toBe('hibernated')
      expect(setup).toBe(oldSetup)
      const recent = '2027-01-01T00:00:00Z'
      const recency = await measure('summaries material recency', () => f.update('target', { lastActiveAt: recent }))
      expect(shell.find(value => value.sessionId === 'target')?.lastActiveAt).toBe(recent)
      expect(settings.rows.find(value => value.sessionId === 'target')?.lastActiveAt).toBe(recent)
      expect(setup?.usage.get('/shown')).toBe(Date.parse(recent))
      const beforeName = settings
      const name = await measure('summaries shell name', () => f.update('target', { name: 'renamed' }))
      expect(shell.find(value => value.sessionId === 'target')?.name).toBe('renamed')
      expect(settings).toBe(beforeName)
      expect(shell.find(value => value.sessionId === 'history-0')).toBe(unchangedShell)
      expect(settings.rows.find(value => value.sessionId === 'history-0')).toBe(unchangedSetup)
      expect(oldShell.find(value => value.sessionId === 'target')?.status).toBe('exited')
      expect(oldSettings.rows.find(value => value.sessionId === 'target')?.lastActiveAt).toBe(stamp)
      expect(ids).not.toHaveBeenCalled()
      expect(row.mock.calls.filter(([, id]) => id !== 'target')).toEqual([])
      expect(f.load).not.toHaveBeenCalled()
      stop(); row.mockClear(); read.mockClear()
      const closed = await measure('summaries closed', () => f.update('target', { name: 'after close', lastActiveAt: stamp }))
      expect(read).not.toHaveBeenCalled()
      expect(row.mock.calls.filter(([, , mode]) => mode === 'summary-fields')).toEqual([])
      return Object.fromEntries(Object.entries({ ignored, status, recency, name, closed }).map(([key, result]) => [key, result.work]))
    } finally { stop(); row.mockRestore(); ids.mockRestore(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('session summaries work1x4x', JSON.stringify({ first, second }))
  for (const action of Object.keys(first))
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action]?.[counter], `${action}:${counter}`).toBe(first[action]?.[counter])
})

it('preserves source-order resume ties, winner positions and active/headless identities across edits', () => {
  const resume = { kind: 'codex.thread', value: 'twins' }
  const f = fixture([
    session('z-first', { resume }), session('middle'), session('a-twin', { resume }),
    session('headless', { resume, headless: true }), session('live', { status: 'live', stoppedAt: undefined }),
  ])
  let settings: SettingsSummary = { rows: [], pending: 0 }, shell: SessionView[] = []
  const stop = autorun(() => {
    settings = settingsView(f.pool).sessions()
    const value = shellViews(f.pool).sessions()
    if (value && value !== LOADING) shell = value
  })
  const check = () => {
    const expected = dedupeSessionsByResume([...f.rows.values()].map(row => row.value) as unknown as SessionView[])
    expect(settings.pending).toBe(0)
    expect(settings.rows.map(row => row.sessionId)).toEqual(expected.map(row => row.sessionId))
    for (const row of settings.rows) {
      expect(row).toMatchObject(Object.fromEntries(SETUP_SESSION_SUMMARY_FIELDS.map(key => [key, (f.rows.get(row.sessionId)!.value as Record<string, unknown>)[key]])))
    }
    const expectedShell = f.source.readerIds({ kind: 'shellSessions' })
      .filter(id => !f.pool.queries.collapsed(id)).sort((a, b) => {
        const left = f.pool.queries.orderKey(a), right = f.pool.queries.orderKey(b)
        return left < right ? -1 : left > right ? 1 : a.localeCompare(b)
      })
    expect(shell.map(row => row.sessionId)).toEqual(expectedShell)
    expect(f.pool.queries.setupSessionCount()).toBe(expectedShell.length)
  }
  try {
    check()
    expect(settings.rows[0]?.sessionId).toBe('z-first')
    expect(f.pool.tables.session.has('live')).toBe(true)
    expect(f.pool.tables.session.has('z-first')).toBe(false)
    f.update('a-twin', { lastActiveAt: '2027-01-01T00:00:00Z' }); check()
    expect(settings.rows[0]?.sessionId).toBe('a-twin')
    f.update('z-first', { status: 'hibernated' }); check()
    f.update('z-first', { status: 'starting', stoppedAt: undefined }); check()
    f.update('z-first', { status: 'reconnecting' }); check()
    f.update('z-first', { status: 'live' }); check()
    f.update('z-first', { status: 'exited', stoppedAt: stamp }); check()
    f.update('headless', { headless: false }); check()
    f.update('headless', { resume: undefined }); check()
    f.update('a-twin', { resume: { kind: 'codex.thread', value: 'other' } }); check()
    f.update('middle', { resume: { kind: 'codex.thread', value: 'other' }, status: 'hibernated' }); check()
    f.update('middle'); check()
    f.update('z-first'); check()
    f.replace([...f.rows.values()].reverse()); check()
    const previous = settings.rows
    previous.reverse()
    f.update('live', { status: 'hibernated', stoppedAt: stamp }); check()
    f.replace([]); check()
    f.replace([session('reopened', { headless: true })]); check()
  } finally { stop(); f.pool.dispose() }
})

describe('material session fields', () => {
  it.each<[string, unknown]>([
    ['name', 'new name'], ['title', 'new title'], ['archived', true],
    ['cwd', '/moved'], ['issueId', 'attached'], ['agentKind', 'grok'],
    ['headless', true], ['resume', { kind: 'codex.thread', value: 'new ref' }],
  ])('publishes current %s without reading other sessions', (field, value) => {
    const f = fixture([session('target'), session('other')])
    let shell: SessionView[] = [], settings: SettingsSummary = { rows: [], pending: 0 }
    const stop = autorun(() => {
      const result = shellViews(f.pool).sessions()
      if (result && result !== LOADING) shell = result
      settings = settingsView(f.pool).sessions()
    })
    try {
      f.update('target', { [field]: value })
      const shown = shell.find(row => row.sessionId === 'target')
      expect(shown).toHaveProperty(field, value)
      if (SETUP_SESSION_SUMMARY_FIELDS.some(key => key === field))
        expect(settings.rows.find(row => row.sessionId === 'target')).toHaveProperty(field, value)
    } finally { stop(); f.pool.dispose() }
  })
})

it('reports exact pending counts, hydrates once, and discards empty pending replacements', () => {
  const f = fixture([session('missing'), session('known')])
  const original = f.pool.residency!.summary.bind(f.pool.residency!)
  const missing = vi.spyOn(f.pool.residency!, 'summary').mockImplementation((entity, id, decorate) =>
    id.endsWith('missing') ? undefined : original(entity, id, decorate))
  let shell: ReturnType<ReturnType<typeof shellViews>['sessions']>,
    settings: SettingsSummary = { rows: [], pending: 0 }
  const stop = autorun(() => {
    shell = shellViews(f.pool).sessions()
    settings = settingsView(f.pool).sessions()
  })
  try {
    expect(shell).toBe(LOADING)
    expect(settings.pending).toBe(1)
    expect(settings.rows.map(row => row.sessionId)).toEqual(['known'])
    expect(f.load).not.toHaveBeenCalled()
    f.pool.hydrate()
    expect(f.load.mock.calls.filter(([, id]) => id === 'missing')).toHaveLength(1)
    expect(shell).not.toBe(LOADING)
    expect(settings.pending).toBe(0)
    expect(settings.rows.map(row => row.sessionId)).toEqual(['missing', 'known'])
    f.pool.hydrate()
    expect(f.load.mock.calls.filter(([, id]) => id === 'missing')).toHaveLength(1)
    f.replace([session('missing')])
    // Hydration stays resident through replacement of the same identity.
    expect(settings.pending).toBe(0)
    f.replace([session('new-missing')])
    expect(settings.pending).toBe(1)
    f.replace([])
    expect(shell).toEqual([])
    expect(settings).toEqual({ rows: [], pending: 0 })
  } finally { stop(); missing.mockRestore(); f.pool.dispose() }
})

it('reads the shell count without constructing summaries and tracks headless and resume changes', () => {
  const resume = { kind: 'codex.thread', value: 'counted' }
  const f = fixture([session('first', { resume }), session('second', { resume }), session('headless', { resume, headless: true })])
  const rows = vi.spyOn(f.pool, 'row'), ids = vi.spyOn(f.pool.queries, 'ids')
  let count = -1
  const read = vi.fn(() => { count = f.pool.queries.setupSessionCount() })
  const stop = autorun(read)
  try {
    expect(count).toBe(2)
    expect(rows).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled()
    f.update('headless', { headless: false }); expect(count).toBe(1)
    f.update('first', { status: 'live', stoppedAt: undefined }); expect(count).toBe(3)
    f.update('first', { status: 'exited', stoppedAt: stamp }); expect(count).toBe(1)
    const before = read.mock.calls.length
    f.update('first', { name: 'renamed' }); expect(read).toHaveBeenCalledTimes(before)
    f.update('second'); expect(count).toBe(1)
    f.update('first'); expect(count).toBe(1)
    f.replace([]); expect(count).toBe(0)
    expect(ids).not.toHaveBeenCalled()
  } finally { stop(); rows.mockRestore(); ids.mockRestore(); f.pool.dispose() }
})
