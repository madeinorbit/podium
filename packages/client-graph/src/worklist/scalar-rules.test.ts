import { expect, it } from 'vitest'
import type { SliceIssue } from '../shared/slice-types'
import { ownPartOfRow } from '../views'
import { standingOf } from './visible'
import { ownBefore, standingBefore } from './scalar-rules-before.test-helper'

const stamp = '2026-10-08T12:00:00Z'
const now = Date.parse(stamp)
const clock = { passed: (at: number) => now > at, reached: (at: number) => now >= at }
const patches = [
  {}, { stage: 'backlog' }, { audience: 'agent', parentId: 'parent' },
  { stage: 'done' }, { closedReason: 'done' }, { closedReason: '' },
  { stage: 'done', parentId: 'parent', closedAt: '2026-10-01T12:00:00Z' },
  { closedReason: 'done', tuckedAt: stamp }, { closedReason: 'cancelled' },
  { stage: 'done', branch: 'issue/merge', gitState: { ahead: 3, shared: false, merged: false } },
  { stage: 'proposed' }, { stage: 'shipping' }, { archived: true }, { deletedAt: stamp },
  { startedBySession: 'origin-seat' }, { parentId: 'parent', startedBySession: 'origin-seat' },
  { startedBySession: 'origin-seat', deps: [{ id: 'origin', type: 'discovered-from' }] },
  { isDraftVessel: true }, { isDraftVessel: true, worktreePath: '/checkout' },
  { pinned: true }, { deferUntil: 'next-message' }, { deferUntil: '2026-10-09T12:00:00Z' },
  { deferUntil: '2026-10-07T12:00:00Z' }, { updatedAt: 'bad date' }, { parentId: '' },
]
for (const [index, patch] of patches.entries()) it(`keeps all eager standing/ordering answers for fixture ${index}`, () => {
  const row = { id: 'root', seq: 7, title: 'Root', repoPath: '/synthetic',
    createdAt: stamp, updatedAt: stamp, stage: 'planning', audience: 'human',
    ...patch } as SliceIssue
  expect({ ...standingOf(row) }).toEqual(standingBefore(row))
  expect({ ...ownPartOfRow(row, clock) }).toEqual(ownBefore(row, clock))
  // Also cover the live path's supplied shared scalar facts, including
  // falsy values that must win over the raw row's values.
  const facts = { excluded: false, finished: false, awaitingMerge: true,
    parentId: '', finishedMs: 0, updatedMs: null, formalParent: null,
    replicaActivityMs: 0, headlessStaffed: false }
  expect({ ...standingOf(row, facts) }).toEqual(standingBefore(row, facts))
  expect({ ...ownPartOfRow(row, clock, facts) }).toEqual(ownBefore(row, clock, facts))
})
