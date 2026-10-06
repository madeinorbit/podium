import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { createWorklistPool } from './create'
import { fixedLocals } from './shared/locals-source'
import { createRowSource, type RowSourceReplica } from './shared/row-source'

it('supplies registered zero-issue prefixes from the production feed and keeps addressed changes flat at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const repos = new Map<string, Record<string, unknown>>()
    for (let n = 0; n < 128 * scale; n++) repos.set(`r${n}`, { id: `r${n}`, prefix: `PREFIX${n}` })
    let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
    const replica: RowSourceReplica = {
      row: (kind, id) => (kind === 'repos' ? repos.get(id) : undefined),
      rows: vi.fn((kind: ReplicaKind) => (kind === 'repos' ? [...repos.values()] : [])),
      subscribeAddressedBatch(listener) {
        addressed = listener
        return () => {
          addressed = () => {}
        }
      },
    }
    const discovery: readonly never[] = []
    const source = createRowSource(
      { principal: { userId: 'operator' }, readLocal: () => discovery, onLocals: () => () => {} },
      replica,
      { pending: EMPTY_PENDING },
    )
    const handle = createWorklistPool(
      source.source,
      fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
    )
    const pool = handle.pool
    let value = '',
      runs = 0
    const stop = autorun(() => {
      runs++
      value = pool.queries.repositoryPrefixKey()
    })
    const publish = (id: string, prefix: string | undefined) => {
      if (prefix === undefined) repos.delete(id)
      else repos.set(id, { id, prefix })
      addressed({ type: 'update', rows: [{ kind: 'repos', id }] })
      source.flush()
    }
    const measure = (name: string, action: () => void) => {
      source.stats.reset()
      vi.mocked(replica.rows).mockClear()
      return measureWork(async () => insideReader(name, action), { pool })
    }
    try {
      expect(pool.queries.count('issue')).toBe(0)
      expect(value.split(',')).toHaveLength(128 * scale)
      const first = await measure('registered prefix first demand', () => {
        pool.queries.repositoryPrefixKey()
      })
      expect(first.work.rows).toBe(0)
      expect(replica.rows).not.toHaveBeenCalled()
      const metadata = await measure('registered prefix unchanged', () => {
        publish('r0', 'PREFIX0')
      })
      expect(runs).toBe(1)
      expect(source.stats.enumerations).toBe(0)
      expect(replica.rows).not.toHaveBeenCalled()
      const rename = await measure('registered prefix rename', () => {
        publish('r0', 'NEW')
      })
      expect(runs).toBe(2)
      expect(value.split(',')).toContain('NEW')
      expect(source.stats.enumerations).toBe(0)
      expect(replica.rows).not.toHaveBeenCalled()
      const remove = await measure('registered prefix removal', () => {
        publish('r0', undefined)
      })
      expect(runs).toBe(3)
      expect(value.split(',')).not.toContain('NEW')
      expect(source.stats.enumerations).toBe(0)
      expect(replica.rows).not.toHaveBeenCalled()
      const add = await measure('registered prefix registration', () => {
        publish('added', 'REGISTERED')
      })
      expect(runs).toBe(4)
      expect(value.split(',')).toContain('REGISTERED')
      expect(source.stats.enumerations).toBe(0)
      expect(replica.rows).not.toHaveBeenCalled()
      samples.push({
        first: first.work,
        metadata: metadata.work,
        rename: rename.work,
        remove: remove.work,
        add: add.work,
      })
    } finally {
      stop()
      handle.dispose()
      source.dispose()
    }
  }
  for (const action of ['first', 'metadata', 'rename', 'remove', 'add'] as const)
    for (const counter of ['rows', 'derivations'] as const)
      expect(samples[1]![action][counter]).toBe(samples[0]![action][counter])
  console.info('[registered repository feed prefixes work1x4x]', JSON.stringify(samples))
})
