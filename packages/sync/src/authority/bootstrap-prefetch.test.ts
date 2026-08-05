import { describe, expect, it } from 'vitest'
import {
  DEVICE_GRADE_PRINCIPAL,
  type EntityRef,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
  type VisibilityStatePort,
} from '../feed/visibility'
import type { SequencedChange } from './change-lifecycle'
import { scopeBootstrap } from './scoping'

const issue = (seq: number, entityId: string): SequencedChange => ({
  seq,
  entity: 'issue',
  entityId,
  op: 'upsert',
  value: { entityId },
})

describe('bootstrap visibility prefetch gate', () => {
  it('turns N distinct refs into one batch preparation and zero point reads', () => {
    const pointReads: string[] = []
    const batches: string[][] = []
    const base: VisibilityStatePort = {
      classOf: (entity) => (entity === 'issue' ? 'personal' : null),
      mayRead: (_user, ref) => {
        pointReads.push(ref.entityId)
        return true
      },
      keyedUserOf: () => null,
    }
    const state: VisibilityStatePort = {
      ...base,
      forBootstrap: (refs: readonly EntityRef[]) => {
        batches.push([
          ...new Set(refs.filter((ref) => ref.entity === 'issue').map((ref) => ref.entityId)),
        ])
        return { ...base, mayRead: () => true }
      },
    }
    const policy = new GrantEdgeVisibilityPolicy(state, new NoDelegationsGranted())

    const world = scopeBootstrap(
      { policy },
      DEVICE_GRADE_PRINCIPAL,
      [issue(1, 'issue-a'), issue(2, 'issue-b'), issue(3, 'issue-a')],
      3,
    )

    expect(pointReads).toEqual([])
    expect(batches).toEqual([['issue-a', 'issue-b']])
    expect(world.changes.map((change) => change.entityId)).toEqual([
      'issue-a',
      'issue-b',
      'issue-a',
    ])
  })
})
