import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import { autorun, observable } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture'
import { startCensus } from '../../../harness/src/mobx-census'
import { handPoolArm } from '../../hand/pool/arm'
import { LeanPool, LOADING } from './pool'

function boot() {
  const corpus = buildCorpus(1, 4443)
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = fixedLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow }).source
  const pool = new LeanPool(replay.source, locals, undefined, () => () => {})
  return { pool, replay, locals }
}

describe('lean memory prototype', () => {
  it('shares observed row computations independently of explicit mount membership', () => {
    const { pool } = boot()
    // Isolate row lifetime from the existing many-edge schema failure in filing.
    const row = observable.box({ title: 'first' }, { deep: false })
    vi.spyOn(pool.filing, 'get').mockImplementation(() => ({
      order: ['one'], views: new Map([['one', row.get()]]),
    }) as unknown as ReturnType<typeof pool.filing.get>)
    const census = startCensus()
    const value = pool.mountRow('one')
    expect(value.get()).toEqual({ title: 'first' })
    const count = () => census.snapshot().entries.filter(entry => entry.kind === 'computed').length
    expect(count()).toBe(0)
    const first = autorun(() => value.get()), second = autorun(() => value.get())
    expect(count()).toBe(1)
    first(); second()
    expect(pool.mounted.size).toBe(1)
    const again = autorun(() => value.get())
    expect(count()).toBe(2)
    again(); pool.unmountRow('one')
    expect(pool.mounted.size).toBe(0)
    census.stop(); pool.dispose()
  })

  it('has one filing computed and creates row computeds only for mounted readers', () => {
    const census = startCensus()
    const { pool } = boot()
    const off = autorun(() => pool.filing.get())
    pool.setWindow(pool.filing.get().order.slice(0, 20))
    const rowOff = pool.filing
      .get()
      .order.slice(0, 20)
      .map((id) => autorun(() => pool.mountRow(id).get()))
    const entries = census.snapshot().entries
    expect(entries.filter((entry) => entry.kind === 'computed')).toHaveLength(21)
    expect(
      entries.filter((entry) =>
        ['map', 'set', 'observableValue', 'array', 'object'].includes(entry.kind),
      ),
    ).toHaveLength(0)
    for (const stop of rowOff) stop()
    for (const id of [...pool.mounted.keys()]) pool.unmountRow(id)
    expect(pool.mounted.size).toBe(0)
    off()
    pool.dispose()
    census.stop()
  })

  it('uses the same visible order and borrowed resident rows as the hand arm', () => {
    const { pool, replay, locals } = boot()
    const hand = handPoolArm.create(replay.source, locals, undefined, { schedule: () => () => {} })
    const off = autorun(() => pool.filing.get())
    expect(pool.filing.get().order).toEqual(hand.pool.order())
    pool.setWindow(pool.filing.get().order.slice(0, 20))
    expect(
      pool.filing
        .get()
        .order.slice(0, 20)
        .map((id) => pool.mountRow(id).get()),
    ).toEqual(
      hand.pool
        .order()
        .slice(0, 20)
        .map((id) => hand.pool.view(id)),
    )
    const id = pool.filing.get().order[0]!
    expect(pool.tables.issue.get(id)).toBe(replay.source.row!('issue', id))
    const old = replay.source.row!(
      'issue',
      id,
    ) as import('@podium/client-graph/shared/slice-types').SliceIssue
    replay.push({
      type: 'update',
      rows: [{ kind: 'issue', id, value: { ...old, title: 'Changed prototype title' } }],
    })
    expect(pool.filing.get().views.get(id)?.title).toBe('Changed prototype title')
    off()
    pool.dispose()
    hand.dispose()
  })

  it('keeps cold relations out, reads declared summaries and batches missing reads', () => {
    const { pool } = boot()
    const cold = pool.residency.ids('issue')[0]!
    expect(pool.tables.issue.has(cold)).toBe(false)
    expect(pool.row('issue', cold, 'summary')).toBeDefined()
    expect(pool.residency.queued()).toBe(0)
    expect(
      pool.residency
        .ids('issue')
        .every((issue) =>
          [...pool.engine.many('issue', issue, 'sessions')].every((id) =>
            pool.tables.session.has(id),
          ),
        ),
    ).toBe(true)
    expect(pool.row('issue', cold)).toBe(LOADING)
    expect(pool.row('issue', cold)).toBe(LOADING)
    expect(pool.row('issue', 'absent')).toBe(LOADING)
    expect(pool.residency.queued()).toBe(2)
    const load = pool.source.row!.bind(pool.source)
    const loaded: string[] = []
    pool.source.row = (entity, id) => {
      loaded.push(id)
      return load(entity, id)
    }
    pool.hydrate()
    expect(loaded).toEqual([cold, 'absent'])
    expect(pool.tables.issue.has(cold)).toBe(true)
    expect(pool.residency.queued()).toBe(0)
    pool.dispose()
  })
})
