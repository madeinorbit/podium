import { describe, expect, it, vi } from 'vitest'
import type { IssueProjection, IssueWire, SessionMeta } from '@podium/model'
import { createEffectiveChanges, type EffectiveReadView, type EffectiveLocalState } from '../engine/effective-changes'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { deriveIssueViews, deriveIssueRollups, type IssueViewInput } from '../replica/issue-views'
import { missionRollup } from '../viewmodels/mission'
import type { IssueNavigationModel } from '../viewmodels/slices/issues'
import { createPresentationModel } from './model'
import type { RelationshipRow } from './relationships'

const NOW = Date.parse('2026-09-18T12:00:00Z')
const timestamp = (delta = 0) => new Date(NOW + delta).toISOString()
const projection = (id: string, extra: Partial<IssueProjection> = {}) => ({ id, seq: 1, title: id, stage: 'in_progress',
  updatedAt: timestamp(-10000), description: { value: '' }, ...extra }) as IssueProjection
const wire = (id: string, extra: Partial<IssueWire> = {}) => ({ id, title: id, readAt: timestamp(-5000), ...extra }) as IssueWire
const session = (id: string, issueId: string, extra: Partial<SessionMeta> = {}) => ({ sessionId: id, issueId, agentKind: 'codex',
  status: 'live', cwd: '/repo', lastActiveAt: timestamp(-10000), ...extra }) as SessionMeta
const row = (kind: ReplicaKind, id: string, value?: object): RelationshipRow => ({ kind, id, value })
const issueRows = (p: IssueProjection) => [row('issueProjections', p.id, p), row('issues', p.id, wire(p.id))]
function harness(seed: RelationshipRow[] = []) {
  const tables = new Map<ReplicaKind, Map<string, object>>()
  const local = { view: 'issues', openIssueId: null, selectedIssueId: null, selectedWorktree: null,
    workspaces: {}, paneA: null, paneB: null, split: false, focusedPane: 'A', dockTab: 'superagent', superOpen: false, drafts: {} } as EffectiveLocalState
  let denyEnumeration = false
  const view: EffectiveReadView = { commit: {},
    ids(kind) { if (denyEnumeration) throw Error('world scan'); return [...(tables.get(kind)?.keys() ?? [])] },
    row: <K extends ReplicaKind>(kind: K, id: string) => tables.get(kind)?.get(id) as ReplicaRows[K] | undefined,
    local: key => local[key],
  }
  function install(changes: RelationshipRow[], replace: boolean) {
    if (replace) tables.clear()
    for (const { kind, id, value } of changes) {
      let table = tables.get(kind); if (!table) tables.set(kind, table = new Map())
      if (value) table.set(id, value); else table.delete(id)
    }
  }
  install(seed, true)
  const source = createEffectiveChanges(view), adapter = createPresentationModel(source)
  adapter.updateTime(NOW)
  return { ...adapter, tables,
    update(changes: RelationshipRow[], replace = false) {
      install(changes, replace); denyEnumeration = !replace
      try {
        if (replace) source.publish({ type: 'replace', reason: 'rescope', view })
        else source.publish({ type: 'update', view, rows: changes.map(({ kind, id }) => ({ kind, id })), local: [] })
      } finally { denyEnumeration = false }
    },
    oracle() {
      const ps = [...(tables.get('issueProjections')?.values() ?? [])] as IssueProjection[]
      const ss = [...(tables.get('sessions')?.values() ?? [])] as SessionMeta[]
      const es = [...(tables.get('issueDeps')?.values() ?? [])] as ReplicaRows['issueDeps'][]
      const inputs: IssueViewInput[] = ps.map(p => ({ ...p, prefix: p.repoId ? (tables.get('repos')?.get(p.repoId) as ReplicaRows['repos'])?.prefix : null,
        readAt: (tables.get('issues')?.get(p.id) as IssueWire)?.readAt,
        deps: es.filter(e => e.fromId === p.id).map(e => ({ id: e.toId, type: e.type })) }))
      const views = deriveIssueViews(inputs, ss, { now: () => NOW })
      return inputs.map(i => ({ ...views.get(i.id)!, title: ps.find(p => p.id === i.id)!.title,
        ...deriveIssueRollups(i, views.get(i.id)!.memberSessionIds, id => ss.find(s => s.sessionId === id)) }))
    },
  }
}

function delta(after: ReturnType<ReturnType<typeof createPresentationModel>['summaryStats']>, before: typeof after) {
  return Object.fromEntries(Object.keys(after).map(k => [k, after[k as keyof typeof after] - before[k as keyof typeof before]]))
}

describe('per-issue shared summaries', () => {
  it('matches replica policies, source order, normalized precedence, shells, archived/headless workers and children', () => {
    const h = harness([
      ...issueRows(projection('z', { repoId: 'repo' as never })), ...issueRows(projection('a', { parentId: 'z' as never, stage: 'done', archived: true })),
      ...issueRows(projection('b', { parentId: 'z' as never, deletedAt: timestamp(-1) })),
      row('repos', 'repo', { id: 'repo', prefix: 'POD' }),
      row('issues', 'z', wire('z', { stage: 'done', prefix: 'STALE', deps: [{ id: 'absent' as never, type: 'blocks' }] })),
      row('issueDeps', 'edge2', { id: 'edge2', fromId: 'a', toId: 'z', type: 'blocks' }),
      row('issueDeps', 'edge1', { id: 'edge1', fromId: 'b', toId: 'z', type: 'related' }),
      row('sessions', 'z', session('z', 'z', { archived: true, phase: 'done' } as never)),
      row('sessions', 'a', session('a', 'z', { headless: true })),
      row('sessions', 'shell', session('shell', 'z', { agentKind: 'shell' })),
    ])
    for (const expected of h.oracle()) expect(h.model.issueSummary(expected.id).getSnapshot()).toEqual(expected)
    expect(h.model.issueSummary('z').getSnapshot()?.childIds).toEqual(['a', 'b'])
    expect(h.model.issueSummary('z').getSnapshot()?.memberSessionIds).toEqual(['z', 'a'])
    expect(h.model.issueSummary('missing').getSnapshot()).toBeUndefined()
    h.destroy()
  })

  it('shares one derivation, isolates concerns, and suppresses equivalent visible updates', () => {
    const p = projection('a'), s = session('s', 'a')
    const h = harness([...issueRows(p), ...issueRows(projection('b')), row('sessions', 's', s)])
    const a = h.model.issueSummary('a'), b = h.model.issueSummary('b')
    const one = vi.fn(), two = vi.fn(), unrelated = vi.fn()
    const off = [a.subscribe(one), h.model.issueSummary('a').subscribe(two), b.subscribe(unrelated)]
    const before = h.summaryStats(), prior = a.getSnapshot(), stable = b.getSnapshot()
    h.update([row('sessions', 's', { ...s, lastActiveAt: timestamp(1000) })])
    expect(delta(h.summaryStats(), before)).toMatchObject({ summaries: 1, unread: 1, phases: 0, membership: 0, children: 0, readiness: 0 })
    expect(one).toHaveBeenCalledOnce(); expect(two).toHaveBeenCalledOnce(); expect(unrelated).not.toHaveBeenCalled()
    expect(a.getSnapshot()?.unread).toBe(true); expect(a.getSnapshot()).not.toBe(prior); expect(b.getSnapshot()).toBe(stable)
    const visible = a.getSnapshot(), after = h.summaryStats()
    h.update([row('sessions', 's', { ...s, lastActiveAt: timestamp(2000) })])
    expect(a.getSnapshot()).toBe(visible); expect(one).toHaveBeenCalledOnce()
    expect(delta(h.summaryStats(), after)).toMatchObject({ summaries: 0, unread: 1, phases: 0 })
    const indexes = h.relationshipStats(), counts = h.summaryStats()
    h.update([row('issueProjections', 'a', { ...p, title: 'Renamed' })])
    expect(h.relationshipStats()).toEqual(indexes)
    expect(delta(h.summaryStats(), counts)).toMatchObject({ summaries: 1, unread: 0, phases: 0, membership: 0, children: 0, readiness: 0 })
    off.forEach(fn => fn()); expect(h.summaryStats().observed).toBe(0)
    h.destroy()
  })

  it('tracks missing targets, incoming edges, child stages, shell transitions and both sides of reassignment', () => {
    const a = projection('a'), b = projection('b'), s = session('s', 'a')
    const h = harness([...issueRows(a), ...issueRows(b), row('sessions', 's', s),
      row('issueDeps', 'e', { id: 'e', fromId: 'a', toId: 'late', type: 'blocks' })])
    const off = ['a', 'b'].map(id => h.model.issueSummary(id).subscribe(() => {}))
    const check = () => { for (const expected of h.oracle()) expect(h.model.issueSummary(expected.id).getSnapshot()).toEqual(expected) }
    expect(h.model.issueSummary('a').getSnapshot()?.ready).toBe(true)
    h.update(issueRows(projection('late', { parentId: 'a' as never }))); check()
    expect(h.model.issueSummary('a').getSnapshot()?.blocked).toBe(true)
    h.update([row('issueProjections', 'late', projection('late', { parentId: 'a' as never, stage: 'done' }))]); check()
    h.update([row('sessions', 's', { ...s, issueId: 'b' })]); check()
    h.update([row('sessions', 's', { ...s, issueId: 'b', agentKind: 'shell' })]); check()
    h.update([row('issueProjections', 'late'), row('issues', 'late')]); check()
    h.update([row('issueDeps', 'e')]); check()
    off.forEach(fn => fn()); h.destroy()
  })

  it('advances a quiet snooze only from explicit time and preserves equal results', () => {
    const h = harness(issueRows(projection('a', { deferUntil: timestamp(60000) })))
    const a = h.model.issueSummary('a'), listener = vi.fn(), off = a.subscribe(listener)
    const initial = a.getSnapshot()
    h.updateTime(NOW + 30000); expect(a.getSnapshot()).toBe(initial); expect(listener).not.toHaveBeenCalled()
    h.updateTime(NOW + 60000); expect(a.getSnapshot()?.ready).toBe(true); expect(listener).toHaveBeenCalledOnce()
    expect(() => h.updateTime(NaN)).toThrow()
    off(); h.destroy()
  })

  it('releases on unmount, bounds cold roots, drops obsolete entries and prevents principal resurrection', () => {
    const h = harness(issueRows(projection('a'))), cell = h.model.issueSummary('a')
    const off = cell.subscribe(() => {})
    expect(h.summaryStats().nodes).toBeGreaterThan(0)
    off(); expect(h.summaryStats().nodes).toBe(0)
    for (let i = 0; i < 1000; i++) h.model.issueSummary(`missing${i}`).getSnapshot()
    expect(h.summaryStats().idleRoots).toBe(128); expect(h.summaryStats().nodes).toBe(256)
    cell.getSnapshot()
    h.update([], true)
    expect(cell.getSnapshot()).toBeUndefined()
    h.update(issueRows(projection('a', { title: 'Readmitted' })), true)
    expect(cell.getSnapshot()?.title).toBe('Readmitted')
    h.destroy(); expect(cell.getSnapshot()).toBeUndefined(); expect(h.summaryStats().nodes).toBe(0)
    const next = harness(issueRows(projection('a', { title: 'Other principal' })))
    expect(next.model.issueSummary('a').getSnapshot()?.title).toBe('Other principal'); expect(cell.getSnapshot()).toBeUndefined()
    next.destroy()
  })

  it('publishes atomic batches, handles reentrancy and isolates observer errors', () => {
    const h = harness([...issueRows(projection('a')), ...issueRows(projection('b'))])
    const a = h.model.issueSummary('a'), b = h.model.issueSummary('b'), seen: string[] = []
    const raw = h.model.row('issueProjections', 'b'); raw.getSnapshot()
    const off = [a.subscribe(() => { expect(raw.getSnapshot()?.title).toBe('B'); seen.push(b.getSnapshot()!.title); throw Error('observer') }), b.subscribe(() => { seen.push(a.getSnapshot()!.title) })]
    expect(() => h.update([row('issueProjections', 'a', projection('a', { title: 'A' })), row('issueProjections', 'b', projection('b', { title: 'B' }))])).toThrow()
    expect(seen).toEqual(['B', 'A'])
    off.forEach(fn => fn())
    const nested: string[] = []
    const stop = a.subscribe(() => {
      nested.push(a.getSnapshot()!.title)
      if (nested.length === 1) h.update([row('issueProjections', 'a', projection('a', { title: 'Nested' }))])
    })
    h.update([row('issueProjections', 'a', projection('a', { title: 'Outer' }))])
    expect(nested).toEqual(['Outer', 'Nested'])
    stop(); h.destroy()
  })
})

describe('mission dependency closure and measured isolation', () => {
  it('matches formal, archived provenance, spin-off, reparenting and dependency policies', () => {
    const ps = [projection('root'), projection('child', { parentId: 'root' as never }),
      projection('proposal', { stage: 'proposed', startedBySession: 's' as never }),
      projection('archived', { archived: true, startedBySession: 's' as never }),
      projection('nested', { startedBySession: 'archived-session' as never }), projection('tip', { stage: 'review' })]
    const ss = [session('s', 'child'), session('archived-session', 'archived'), session('t', 'tip')]
    const h = harness([...ps.flatMap(issueRows), ...ss.map(s => row('sessions', s.sessionId, s)),
      row('issueDeps', 'spin', { id: 'spin', fromId: 'tip', toId: 'child', type: 'discovered-from' })])
    const off = ps.map(p => h.model.issueMission(p.id).subscribe(() => {}))
    function check() {
      const ps = [...h.tables.get('issueProjections')!.values()] as IssueProjection[]
      const ss = [...h.tables.get('sessions')!.values()] as SessionMeta[]
      const summaries = h.oracle()
      const issues = ps.map(p => {
        const edges = [...h.tables.get('issueDeps')!.values()] as ReplicaRows['issueDeps'][]
        return { ...p, ...summaries.find(i => i.id === p.id), deps: edges.filter(e => e.fromId === p.id).map(e => ({ id: e.toId, type: e.type })) } as unknown as IssueNavigationModel
      })
      for (const p of ps) expect(h.model.issueMission(p.id).getSnapshot()).toEqual(missionRollup(issues, ss, p.id))
    }
    check()
    h.update([row('sessions', 's', { ...ss[0], status: 'exited' })]); check()
    h.update([row('issueProjections', 'child', { ...ps[1], parentId: 'proposal' })]); check()
    h.update([row('sessions', 's', { ...ss[0], issueId: 'proposal' })]); check()
    h.update([row('issueDeps', 'block', { id: 'block', fromId: 'proposal', toId: 'tip', type: 'blocks' })]); check()
    h.update([row('issueProjections', 'tip', { ...ps[5], stage: 'done' })]); check()
    h.update([row('issueDeps', 'spin')]); check()
    off.forEach(fn => fn()); h.destroy()
  })

  it('beats the coarse arm at live cardinality, with equal outputs and a failing legacy control', () => {
    const ps = Array.from({ length: 4867 }, (_, n) => projection(`i${n}`, {
      seq: n + 1, stage: n % 5 === 4 ? 'done' : 'in_progress', parentId: n % 5 ? `i${n - n % 5}` as never : undefined,
    }))
    let sessions = Array.from({ length: 4304 }, (_, n) => session(`s${n}`, `i${n}`))
    const h = harness([...ps.flatMap(issueRows), ...sessions.map(s => row('sessions', s.sessionId, s))])
    const group = ps.slice(0, 200), groupIds = new Set(group.map(i => i.id))
    const issues = group.map(p => ({ ...p, deps: [], dependents: [], blocked: false }) as unknown as IssueNavigationModel)
    const off: Array<() => void> = []
    for (const p of group) {
      off.push(h.model.issueMission(p.id).subscribe(() => {}))
      off.push(h.model.issueSummary(p.id).subscribe(() => {}))
    }
    // Two summary observers share the same derivation; no keepalive observers
    // beyond the 200 rows actually under comparison.
    off.push(h.model.issueSummary('i1').subscribe(() => {}))
    const before = h.summaryStats()
    sessions = sessions.map(s => s.sessionId === 's1' ? { ...s, lastActiveAt: timestamp(1000) } : s)
    h.update([row('sessions', 's1', sessions[1])])
    const pilot = delta(h.summaryStats(), before)
    const legacy = { mission: 0, sessionVisits: 0, summaries: 0, groupSessionVisits: 0, rollupSessionVisits: 0 }
    const gs = sessions.filter(s => groupIds.has(s.issueId!))
    const legacyViews = deriveIssueViews(group, gs, { now: () => NOW })
    for (const p of issues) {
      legacy.mission++
      const own = gs.filter(s => { legacy.sessionVisits++; legacy.groupSessionVisits++; return s.issueId === p.id })
      expect(h.model.issueMission(p.id).getSnapshot()).toEqual(missionRollup(issues, gs, p.id))
      expect(h.model.issueSummary(p.id).getSnapshot()?.memberSessionIds).toEqual(own.map(s => s.sessionId))
      legacy.summaries++
      const v = legacyViews.get(p.id)!
      const rollup = deriveIssueRollups({ readAt: timestamp(-5000), updatedAt: p.updatedAt }, v.memberSessionIds, id => { legacy.sessionVisits++; legacy.rollupSessionVisits++; return gs.find(s => s.sessionId === id) })
      expect(h.model.issueSummary(p.id).getSnapshot()).toEqual({ ...v, title: p.title, ...rollup })
    }
    const budget = (counts: typeof pilot) => {
      expect(counts.mission).toBeLessThanOrEqual(2)
      expect(counts.sessionVisits).toBeLessThanOrEqual(7)
      expect(counts.summaries).toBe(1)
    }
    budget(pilot)
    expect(() => budget(legacy)).toThrow()
    expect(legacy).toEqual({ mission: 200, sessionVisits: 40200, summaries: 200, groupSessionVisits: 40000, rollupSessionVisits: 200 })
    expect(pilot).toMatchObject({ mission: 2, missionSessionVisits: 6, sessionVisits: 7, summaries: 1 })
    const quiet = h.summaryStats()
    h.update([row('sessions', 's4000', { ...sessions[4000], lastActiveAt: timestamp(1000) })])
    expect(delta(h.summaryStats(), quiet)).toMatchObject({ mission: 0, sessionVisits: 0, summaries: 0 })
    off.forEach(fn => fn())
    expect(h.summaryStats()).toMatchObject({ nodes: 0, observed: 0, idleRoots: 0 })
    const unmounted = h.summaryStats()
    h.update([row('sessions', 's1', { ...sessions[1], lastActiveAt: timestamp(2000) })])
    expect(delta(h.summaryStats(), unmounted)).toMatchObject({ mission: 0, sessionVisits: 0, summaries: 0 })
    console.info('[E3 summary A/B]', JSON.stringify({ legacy, pilot, equalMissionOutputs: 200, equalSummaryOutputs: 200,
      fixture: { issues: ps.length, sessions: sessions.length }, negativeControl: 'legacy fails pilot budget', unmountedNodes: h.summaryStats().nodes }))
    h.destroy()
  })
})
