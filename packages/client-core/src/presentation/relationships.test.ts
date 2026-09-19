import { describe, expect, it, vi } from 'vitest'
import type { IssueWire, SessionMeta } from '@podium/model'
import { createEffectiveChanges, type EffectiveLocalState, type EffectiveReadView } from '../engine/effective-changes'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { indexMissionSessions } from '../viewmodels/mission'
import { indexSessionOwnership, sessionsForIssueNav } from '../viewmodels/session-ownership'
import { createPresentationModel } from './model'
import { createRelationshipIndexes, relationshipKey, type RelationshipRow, type Relationship } from './relationships'

const issue = (id: string, extra: Partial<IssueWire> = {}) => ({ id, worktreePath: null, deps: [], ...extra }) as IssueWire
const session = (id: string, extra: Partial<SessionMeta> = {}) => ({ sessionId: id, cwd: '/repo', ...extra }) as SessionMeta
const change = (kind: ReplicaKind, id: string, value?: object): RelationshipRow => ({ kind, id, value })
function harness() {
  const rows = new Map<ReplicaKind, Map<string, object>>()
  const local = { view: 'issues', openIssueId: null, selectedIssueId: null, selectedWorktree: null,
    workspaces: {}, paneA: null, paneB: null, split: false, focusedPane: 'A', dockTab: 'superagent', superOpen: false, drafts: {} } as EffectiveLocalState
  let forbidEnumeration = false
  const view: EffectiveReadView = {
    commit: {}, ids: kind => { if (forbidEnumeration) throw Error('collection enumeration'); return [...(rows.get(kind)?.keys() ?? [])] },
    row: <K extends ReplicaKind>(kind: K, id: string) => rows.get(kind)?.get(id) as ReplicaRows[K] | undefined,
    local: key => local[key],
  }
  const source = createEffectiveChanges(view)
  const adapter = createPresentationModel(source)
  return { ...adapter, source,
    update(changes: RelationshipRow[], replace = false) {
      if (replace) rows.clear()
      for (const { kind, id, value } of changes) {
        let table = rows.get(kind)
        if (!table) rows.set(kind, table = new Map())
        if (value) table.set(id, value); else table.delete(id)
      }
      forbidEnumeration = !replace
      try {
        if (replace) source.publish({ type: 'replace', reason: 'rescope', view })
        else source.publish({ type: 'update', rows: changes.map(({ kind, id }) => ({ kind, id })), local: [], view })
      } finally { forbidEnumeration = false }
    },
    read(kind: Relationship, id: string, type?: string) { return adapter.model.relationship(kind, id, type).getSnapshot() },
  }
}

describe('incremental relationship membership', () => {
  it('moves only one session and old/new buckets; content rows remain separate and publication is atomic', () => {
    const h = harness()
    h.update([change('issues', 'a', issue('a')), change('issues', 'b', issue('b')), change('sessions', 's', session('s', { issueId: 'a' as never }))])
    const old = h.model.relationship('sessionsByIssue', 'a')
    const next = h.model.relationship('sessionsByIssue', 'b')
    const empty = h.model.relationship('sessionsByIssue', 'unrelated').getSnapshot()
    expect(old.getSnapshot()).toEqual(['s'])
    expect(next.getSnapshot()).toEqual([])
    const notify = vi.fn(() => {
      expect(old.getSnapshot()).toEqual([])
      expect(next.getSnapshot()).toEqual(['s'])
      expect(h.model.row('sessions', 's').getSnapshot()?.issueId).toBe('b')
    })
    old.subscribe(notify); next.subscribe(notify)
    const before = h.relationshipStats()
    h.update([change('sessions', 's', session('s', { issueId: 'b' as never }))])
    expect(notify).toHaveBeenCalledTimes(2)
    expect(h.relationshipStats().sessionMembershipEvaluations - before.sessionMembershipEvaluations).toBe(1)
    expect(h.relationshipStats().bucketWrites - before.bucketWrites).toBe(4)
    expect(h.model.relationship('sessionsByIssue', 'unrelated').getSnapshot()).toBe(empty)
    const stable = next.getSnapshot(), counts = h.relationshipStats()
    h.update([change('sessions', 's', session('s', { issueId: 'b' as never, name: 'new content', agentKind: 'shell' }))])
    expect(next.getSnapshot()).toBe(stable)
    expect(h.relationshipStats()).toEqual(counts)
    expect(h.model.row('sessions', 's').getSnapshot()?.name).toBe('new content')
    h.destroy()
  })

  it('tracks empty/missing keys privately and handles creation, eviction, removal and later admission', () => {
    const h = harness()
    const bucket = h.model.relationship('sessionsByIssue', 'missing')
    const notify = vi.fn(); bucket.subscribe(notify)
    h.update([change('sessions', 's', session('s', { issueId: 'missing' as never }))])
    expect(bucket.getSnapshot()).toEqual([])
    expect(h.read('attachedSessionsByIssue', 'missing')).toEqual([])
    h.update([change('issues', 'missing', issue('missing'))])
    expect(bucket.getSnapshot()).toEqual(['s'])
    h.update([change('issues', 'missing')]) // absent means eviction OR removal
    expect(bucket.getSnapshot()).toEqual([])
    h.update([change('issues', 'missing', issue('missing'))])
    expect(bucket.getSnapshot()).toEqual(['s'])
    h.update([change('sessions', 's')])
    expect(bucket.getSnapshot()).toEqual([])
    expect(notify).toHaveBeenCalledTimes(4)
    h.destroy()
  })

  it('matches ownership rules across roots, explicit attachment, archive, headless and shells', () => {
    const h = harness()
    const issues = [issue('a', { worktreePath: '/repo' }), issue('b', { worktreePath: '/repo/nested' })]
    const sessions = [session('fallback'), session('nested', { cwd: '/repo/nested/sub' }), session('explicit', { issueId: 'a' as never, cwd: '/else' }),
      session('archived', { archived: true }), session('headless', { headless: true }), session('shell', { agentKind: 'shell' })]
    h.update([...issues.map(i => change('issues', i.id, i)), ...sessions.map(s => change('sessions', s.sessionId, s))])
    const roots = issues.map(i => i.worktreePath!)
    const oracle = indexSessionOwnership(sessions, issues, roots)
    for (const i of issues) {
      expect(h.read('sessionsByIssue', i.id)).toEqual(sessionsForIssueNav(i, sessions, roots, { includeShells: true }).map(s => s.sessionId).sort())
      expect(h.read('sessionsByWorktree', i.worktreePath!)).toEqual((oracle.sessionsByWorktree.get(i.worktreePath!) ?? []).map(s => s.sessionId).sort())
    }
    h.update([change('sessions', 'archived', session('archived')), change('sessions', 'headless', session('headless'))])
    expect(h.read('sessionsByIssue', 'a')).toEqual(['archived', 'explicit', 'fallback', 'headless', 'shell'])
    h.destroy()
  })

  it('revisits only sessions beneath changed roots, including unmatched cwd candidates and slash spellings', () => {
    const h = harness()
    h.update([change('issues', 'a', issue('a', { worktreePath: '/repo' })), change('sessions', 's', session('s', { cwd: '/repo/nested/sub' })), change('sessions', 'other', session('other', { cwd: '/else' }))])
    const before = h.relationshipStats()
    h.updateWorktreePaths(['/repo/nested'])
    expect(h.read('sessionsByIssue', 'a')).toEqual([])
    expect(h.read('sessionsByWorktree', '/repo/nested')).toEqual(['s'])
    expect(h.relationshipStats().sessionMembershipEvaluations - before.sessionMembershipEvaluations).toBe(1)
    h.updateWorktreePaths([], ['/repo/nested'])
    expect(h.read('sessionsByIssue', 'a')).toEqual(['s'])
    h.updateWorktreePaths(['/else/'])
    expect(h.read('sessionsByWorktree', '/else/')).toEqual([])
    h.updateWorktreePaths(['/else'])
    expect(h.read('sessionsByWorktree', '/else')).toEqual(['other'])
    h.update([change('issues', 'b', issue('b', { worktreePath: '/repo/nested' }))])
    expect(h.read('sessionsByIssue', 'b')).toEqual(['s'])
    h.update([change('issues', 'b', issue('b', { worktreePath: '/else' }))])
    expect(h.read('sessionsByIssue', 'a')).toEqual(['s'])
    expect(h.read('sessionsByIssue', 'b')).toEqual(['other'])
    h.destroy()
  })

  it('updates child, repository and typed reverse-dependency buckets without scanning sessions', () => {
    const h = harness()
    const child = issue('c', { parentId: 'p' as never, repoId: 'r' as never, deps: [{ id: 'target', type: 'discovered-from' }] as never })
    h.update([change('issues', 'c', child), change('sessions', 's', session('s'))])
    expect(h.read('childrenByParent', 'p')).toEqual([])
    expect(h.read('dependentsByIssue', 'target', 'discovered-from')).toEqual([])
    h.update([change('issues', 'p', issue('p')), change('issues', 'target', issue('target')), change('repos', 'r', { id: 'r' })])
    expect(h.read('childrenByParent', 'p')).toEqual(['c'])
    expect(h.read('issuesByRepository', 'r')).toEqual(['c'])
    expect(h.read('dependentsByIssue', 'target', 'discovered-from')).toEqual(['c'])
    const before = h.relationshipStats()
    h.update([change('issues', 'c', { ...child, parentId: 'target', deps: [{ id: 'p', type: 'blocks' }] })])
    expect(h.read('childrenByParent', 'p')).toEqual([])
    expect(h.read('childrenByParent', 'target')).toEqual(['c'])
    expect(h.read('dependentsByIssue', 'target', 'discovered-from')).toEqual([])
    expect(h.read('dependentsByIssue', 'p', 'blocks')).toEqual(['c'])
    expect(h.relationshipStats().sessionMembershipEvaluations).toBe(before.sessionMembershipEvaluations)
    expect(h.relationshipStats().issueMembershipEvaluations - before.issueMembershipEvaluations).toBe(1)
    h.update([change('issues', 'c', { ...child, archived: true })])
    expect(h.read('childrenByParent', 'p')).toEqual([])
    h.update([change('issues', 'c', { ...child, deletedAt: 'now' })])
    expect(h.read('childrenByParent', 'p')).toEqual([])
    h.update([change('repos', 'r'), change('issues', 'target')])
    expect(h.read('issuesByRepository', 'r')).toEqual([])
    expect(h.read('dependentsByIssue', 'target', 'discovered-from')).toEqual([])
    h.destroy()
  })

  it('admits normalized projections and edges in either order and purges scope state', () => {
    const h = harness()
    const edge = { id: 'edge', fromId: 'child', toId: 'parent', type: 'blocks' }
    h.update([change('issueDeps', 'edge', edge), change('sessions', 's', session('s', { issueId: 'child' as never }))])
    expect(h.read('dependencyEdgesByIssue', 'parent', 'blocks')).toEqual([])
    h.update([change('issueProjections', 'child', { id: 'child', parentId: 'parent' }), change('issueProjections', 'parent', { id: 'parent' })])
    expect(h.read('dependencyEdgesByIssue', 'parent', 'blocks')).toEqual(['edge'])
    expect(h.read('childrenByParent', 'parent')).toEqual(['child'])
    expect(h.read('sessionsByIssue', 'child')).toEqual(['s'])
    h.update([change('issueProjections', 'parent')])
    expect(h.read('dependencyEdgesByIssue', 'parent', 'blocks')).toEqual([])
    expect(h.read('childrenByParent', 'parent')).toEqual([])
    h.update([change('issueProjections', 'parent', { id: 'parent' })])
    expect(h.read('dependencyEdgesByIssue', 'parent', 'blocks')).toEqual(['edge'])
    h.update([change('issueDeps', 'edge')])
    expect(h.read('dependencyEdgesByIssue', 'parent', 'blocks')).toEqual([])
    h.updateWorktreePaths(['/repo'])
    h.update([], true)
    expect(h.read('sessionsByIssue', 'child')).toEqual([])
    expect(h.read('childrenByParent', 'parent')).toEqual([])
    h.update([change('sessions', 's', session('s'))])
    expect(h.read('sessionsByWorktree', '/repo')).toEqual([])
    h.destroy()
    expect(h.model.relationship('sessionsByIssue', 'child').getSnapshot()).toBeUndefined()
  })

  it('keeps unaffected bucket identities and clears all held cells across stop/start and rescope', () => {
    const h = harness()
    h.update([change('issues', 'a', issue('a')), change('sessions', 's', session('s', { issueId: 'a' as never }))])
    const cell = h.model.relationship('sessionsByIssue', 'a')
    expect(cell).toBe(h.model.relationship('sessionsByIssue', 'a'))
    expect(cell.getSnapshot()).toEqual(['s'])
    h.stop()
    h.update([], true)
    expect(cell.getSnapshot()).toEqual(['s'])
    h.start()
    expect(cell.getSnapshot()).toEqual([])
    h.destroy()
    expect(cell.getSnapshot()).toBeUndefined()
  })

  it('A/B: legacy membership visits FAIL the new assertion with equal membership and content work', () => {
    const count = 1000, updates = 100
    const h = harness()
    let sessions = Array.from({ length: count }, (_, n) => session(`s${n}`, { issueId: 'a' as never, name: 'initial' }))
    h.update([change('issues', 'a', issue('a')), ...sessions.map(s => change('sessions', s.sessionId, s))], true)
    const baseline = h.relationshipStats()
    let legacyVisits = 0, legacyContentReads = 0, incrementalContentReads = 0
    const expected = sessions.map(s => s.sessionId).sort()
    const bucket = h.model.relationship('attachedSessionsByIssue', 'a')
    const stable = bucket.getSnapshot()
    for (let n = 0; n < updates; n++) {
      sessions = [...sessions]
      sessions[0] = { ...sessions[0]!, name: `content ${n}` }
      const measured = new Proxy(sessions, { get(target, prop, receiver) {
        if (prop === Symbol.iterator) return function* () { for (const s of target) { legacyVisits++; yield s } }
        return Reflect.get(target, prop, receiver)
      } })
      const legacy = indexMissionSessions(measured)
      h.update([change('sessions', 's0', sessions[0])])
      expect(legacy.byIssue.get('a')!.map(s => s.sessionId).sort()).toEqual(expected)
      expect(bucket.getSnapshot()).toBe(stable)
      expect(bucket.getSnapshot()).toEqual(expected)
      expect(legacy.byIssue.get('a')![0]!.name).toBe(`content ${n}`); legacyContentReads++
      expect(h.model.row('sessions', 's0').getSnapshot()!.name).toBe(`content ${n}`); incrementalContentReads++
    }
    expect(legacyContentReads).toBe(incrementalContentReads)
    expect(legacyContentReads).toBe(updates)
    expect(legacyVisits).toBe(count * updates)
    expect(() => expect(legacyVisits).toBe(0)).toThrow() // real negative control
    expect(h.relationshipStats()).toEqual(baseline)
    console.log(`E2 A/B: ${count} sessions x ${updates} content updates; legacy membership visits=${legacyVisits}, incremental evaluations=0, bucket writes=0; content reads=${legacyContentReads}/${incrementalContentReads}; memberships equal`)
    h.destroy()
  })

  it('direct index exposes frozen empty sets without inventing endpoints', () => {
    const index = createRelationshipIndexes()
    const key = relationshipKey('childrenByParent', '')
    expect(Object.isFrozen(index.snapshot(key))).toBe(true)
    index.apply([change('issues', 'c', issue('c', { parentId: '' as never }))])
    expect(index.snapshot(key)).toEqual([])
    index.destroy()
  })
})
