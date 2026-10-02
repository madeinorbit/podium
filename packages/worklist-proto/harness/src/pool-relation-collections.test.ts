import { describe, expect, it } from 'vitest'
import { runInAction } from 'mobx'
import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph'
import { SCHEMA, type ModelSchema } from '@podium/client-graph/shared/schema'
import { HandPool } from '../../arms/hand/pool/pool'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { checkRelations } from '../../shared/src/probes/relations-check'
import type { RowRecord } from '../../shared/src/stats'
import { scanRelations as handScan } from '../../arms/hand/pool/enumerate'
import { scanRelations as mobxScan } from './adapters/mobx-rebuild'
import { tracked } from './adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap({ errors: true })
const STAMP = '2026-09-01T12:00:00Z'
const issue = (id: string, deps: { id: string; type: string }[] = []): RowRecord => ({ kind: 'issue', id,
  value: { id, seq: 1, title: 'Synthetic', repoPath: '/synthetic', createdAt: STAMP, updatedAt: STAMP, stage: 'backlog', deps } })
const session = (id: string): RowRecord => ({ kind: 'session', id, value: { sessionId: id, issueId: 'a',
  status: 'exited', cwd: '/synthetic', agentKind: 'codex', lastActiveAt: STAMP, resume: { kind: 'codex-thread', value: 'same' } } })

describe('page schema generic relation collections', () => {
  it('keeps every same-type target while singular provenance still takes its first edge', () => {
    const dependencies = { ...SCHEMA.issue.relations.pageDependencies, allTypes: undefined, edgeType: 'blocks' }
    const dependents = { ...SCHEMA.issue.relations.pageDependents, allTypes: undefined, edgeType: 'blocks' }
    const schema: ModelSchema = { ...SCHEMA, issue: { ...SCHEMA.issue,
      relations: { ...SCHEMA.issue.relations, pageDependencies: dependencies, pageDependents: dependents } } }
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(STAMP) }, schema)
    try {
      pool.apply({ type: 'replace', rows: [issue('a'), issue('b'), issue('owner', [
        { id: 'a', type: 'blocks' }, { id: 'b', type: 'blocks' }, { id: 'a', type: 'blocks' },
        { id: 'a', type: 'discovered-from' }, { id: 'b', type: 'discovered-from' },
      ])] })
      expect(tracked(() => [...pool.graph.many('issue', 'owner', 'pageDependencies')])).toEqual(['a', 'b'])
      expect(tracked(() => pool.graph.one('issue', 'owner', 'discoveredFrom'))).toBe('a')
      pool.apply({ type: 'update', rows: [issue('owner', [{ id: 'b', type: 'blocks' }])] })
      expect(tracked(() => [...pool.graph.many('issue', 'a', 'pageDependents')])).toEqual([])
      expect(tracked(() => [...pool.graph.many('issue', 'b', 'pageDependents')])).toEqual(['owner'])
      expect(tracked(() => pool.graph.one('issue', 'owner', 'discoveredFrom'))).toBe(null)
    } finally { pool.dispose() }
  })

  it('exposes collection model getters and retains cold edge keys without loading payloads', () => {
    const rows = [issue('a'), issue('b'), { ...issue('owner', [{ id: 'a', type: 'custom' }, { id: 'b', type: 'blocks' }]),
      value: { ...issue('owner').value, stage: 'done', archived: true, deps: [{ id: 'a', type: 'custom' }, { id: 'b', type: 'blocks' }] } }]
    const loads: string[] = []
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(STAMP) }, undefined,
      { load: (entity, id) => { loads.push(`${entity}:${id}`); return rows.find(row => row.kind === entity && row.id === id)?.value },
        summaries: { issue: ['deps', 'stage', 'archived', 'parentId'] }, schedule: () => () => {} })
    try {
      pool.apply({ type: 'replace', rows })
      expect(pool.residency!.isCold('issue', 'owner')).toBe(true)
      expect(tracked(() => [...pool.graph.many('issue', 'owner', 'pageDependencies')])).toEqual(['a', 'b'])
      expect(tracked(() => [...pool.graph.many('issue', 'b', 'pageDependents')])).toEqual(['owner'])
      expect(pool.hydrate()).toBe(0)
      expect(loads).toEqual([])
      expect(tracked(() => pool.row('issue', 'owner'))).toBe(LOADING)
      expect(pool.hydrate()).toBe(1)
      expect(loads).toEqual(['issue:owner'])
      expect(tracked(() => pool.model('issue', 'owner')!.pageDependencies.ready.map(row => row.id))).toEqual(['a', 'b'])
      pool.apply({ type: 'update', rows: [issue('owner', [{ id: 'b', type: 'custom' }])] })
      expect(tracked(() => pool.model('issue', 'owner')!.pageDependencies.ready.map(row => row.id))).toEqual(['b'])
      expect(tracked(() => [...pool.graph.many('issue', 'a', 'pageDependents')])).toEqual([])
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'owner', value: undefined }] })
      expect(tracked(() => [...pool.graph.many('issue', 'b', 'pageDependents')])).toEqual([])
    } finally { pool.dispose() }
  })

  it('places a resumed winner in the first member slot and restores live twins in ID order', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(STAMP) })
    const first = session('a-first'), winner = { ...session('z-winner'), value: { ...session('z-winner').value, status: 'hibernated' } }
    try {
      pool.apply({ type: 'replace', rows: [issue('a'), first, winner,
        { ...session('m-middle'), value: { ...session('m-middle').value, resume: undefined } }] })
      const order = () => tracked(() => [...pool.graph.many('issue', 'a', 'missionSessions')]
        .sort((a, b) => pool.graph.orderKey('session', a).localeCompare(pool.graph.orderKey('session', b))))
      expect(order()).toEqual(['z-winner', 'm-middle'])
      pool.apply({ type: 'update', rows: [{ ...first, value: { ...first.value, status: 'live' } }] })
      expect(order()).toEqual(['a-first', 'm-middle', 'z-winner'])
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'a-first', value: undefined }] })
      expect(order()).toEqual(['m-middle', 'z-winner'])
    } finally { pool.dispose() }
  })

  it.each(['mobx', 'hand'] as const)('keeps multi-edges and uncollapsed membership correct in the %s engine and rebuild', arm => {
    const locals = { selectedIssueId: null, coarseNow: Date.parse(STAMP) }
    const pool = arm === 'mobx' ? new MobxPool(locals) : new HandPool(DISABLED_READ_FENCE, locals)
    const reader = pool instanceof MobxPool ? pool.graph : pool.engine
    const read = <T,>(fn: () => T) => pool instanceof MobxPool ? tracked(fn) : fn()
    const rows = [issue('a'), issue('b'), issue('owner', [{ id: 'a', type: 'custom' }, { id: 'b', type: 'blocks' }]), session('twin-a'), session('twin-b')]
    const ids = { issue: new Set(['a', 'b', 'owner']), session: new Set(['twin-a', 'twin-b']) }
    const scope = [{ from: 'issue' as const, relation: 'pageDependencies' }, { from: 'session' as const, relation: 'pageIssue' }]
    const check = () => {
      expect(read(() => checkRelations(reader, ids, scope))).toMatchObject({ total: 0 })
      const scan = runInAction(() => pool instanceof MobxPool ? mobxScan(pool.tables) : handScan(pool.tables))
      expect(read(() => [...reader.many('issue', 'owner', 'pageDependencies')].sort()))
        .toEqual([...scan.many('issue', 'owner', 'pageDependencies')])
      expect(read(() => [...reader.many('issue', 'a', 'pageSessions')].sort()))
        .toEqual([...scan.many('issue', 'a', 'pageSessions')])
    }
    try {
      pool.apply({ type: 'replace', rows }); check()
      expect(read(() => [...reader.many('issue', 'a', 'pageSessions')].sort())).toEqual(['twin-a', 'twin-b'])
      expect(read(() => [...reader.many('issue', 'a', 'missionSessions')])).toHaveLength(1)
      pool.apply({ type: 'update', rows: [issue('owner', [{ id: 'b', type: 'arbitrary-type' }])] }); check()
      expect(read(() => [...reader.many('issue', 'a', 'pageDependents')])).toEqual([])
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'twin-b', value: undefined }, { kind: 'issue', id: 'owner', value: undefined }] })
      ids.session.delete('twin-b'); ids.issue.delete('owner'); check()
      expect(read(() => [...reader.many('issue', 'b', 'pageDependents')])).toEqual([])
      // A planted one-way omission must be reported by the independent probe.
      const broken = { ...reader, one: reader.one.bind(reader), size: reader.size.bind(reader), subset: reader.subset.bind(reader),
        many: (from: Parameters<typeof reader.many>[0], id: string, name: string) => name === 'pageSessions' ? [] : reader.many(from, id, name) }
      expect(read(() => checkRelations(broken, ids, scope)).total).toBeGreaterThan(0)
    } finally { pool.dispose() }
  })

})
