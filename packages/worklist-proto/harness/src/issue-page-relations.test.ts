import { describe, expect, it } from 'vitest'
import { reaction, runInAction } from 'mobx'
import { MobxPool } from '@podium/client-graph/pool'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import { LOADING } from '@podium/client-graph'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
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

  it('borrows exit evidence through the one reader, reacts to rescope and disposes the subscription once', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(STAMP) })
    let receive: (batch: ReplicaAddressedBatch) => void = () => {}
    let kind: 'evicted' | 'removed' | undefined = 'evicted', stops = 0
    const replica = {
      exitKind: (entity: string, id: string) => entity === 'issueProjection' && id === 'opaque' ? kind : undefined,
      subscribeAddressedBatch: (listener: typeof receive) => { receive = listener; return () => { stops++ } },
    }
    const stop = attachIssuePageSource(pool, { replica } as Parameters<typeof attachIssuePageSource>[1])
    const states: unknown[] = []
    const unobserve = reaction(() => pool.row('issueExit', 'opaque'), next => states.push(next), { fireImmediately: true })
    try {
      expect(tracked(() => pool.row('issueExit', 'opaque'))).toEqual({ kind: 'evicted' })
      kind = 'removed'; receive({ type: 'replace', reason: 'rescope' })
      expect(tracked(() => pool.row('issueExit', 'opaque'))).toEqual({ kind: 'removed' })
      kind = undefined; receive({ type: 'replace', reason: 'rescope' })
      expect(tracked(() => pool.row('issueExit', 'opaque'))).toEqual({ kind: undefined })
      expect(states).toEqual([{ kind: 'evicted' }, { kind: 'removed' }, { kind: undefined }])
      unobserve()
      stop(); stop(); pool.dispose()
      expect(stops).toBe(1)
      expect(tracked(() => pool.row('issueExit', 'opaque'))).toBe(LOADING)
    } finally { unobserve(); pool.dispose() }
  })
})
