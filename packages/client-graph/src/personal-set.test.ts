/**
 * THE VIEWER'S PERSONAL SET ON THE ISSUE MODEL (POD-6290; design §2.2).
 *
 * The sidebar is personal: it holds the tasks the viewer started or joined, and
 * the ones carrying their removable "assigned to you by X" row. Those records
 * arrive on the viewer's own `issueUserStates` row; a row holding only a read
 * marker (the viewer opened the task) says nothing about the set.
 *
 * Driven through the real feed (`createRowSource`) into the pool, the way the
 * app gets them: projection first, the user-state row after.
 */

import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { asIssueId, asUserId, issueUserStateRowId } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from './create'
import { fixedLocals } from './shared/locals-source'
import { createRowSource, type RowSourceReplica } from './shared/row-source'

const VIEWER = 'operator'

function feed() {
  const tables = new Map<ReplicaKind, Map<string, Record<string, unknown>>>()
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const replica: RowSourceReplica = {
    row: (kind, id) => tables.get(kind)?.get(id),
    rows: vi.fn((kind: ReplicaKind) => [...(tables.get(kind)?.values() ?? [])]),
    subscribeAddressedBatch(listener) {
      addressed = listener
      return () => {
        addressed = () => {}
      }
    },
  }
  const source = createRowSource(
    { principal: { userId: VIEWER }, readLocal: () => [], onLocals: () => () => {} },
    replica,
    { pending: EMPTY_PENDING },
  )
  const put = (kind: ReplicaKind, id: string, value: Record<string, unknown>) => {
    let table = tables.get(kind)
    if (!table) tables.set(kind, (table = new Map()))
    table.set(id, value)
  }
  const userKey = issueUserStateRowId(asUserId(VIEWER), asIssueId('task'))
  return {
    source,
    put,
    /** The viewer's own user-state row for the task, as the feed delivers it. */
    userState(value: Record<string, unknown>) {
      put('issueUserStates', userKey, { userId: VIEWER, entityId: 'task', ...value })
      addressed({ type: 'update', rows: [{ kind: 'issueUserStates', id: userKey }] })
      source.flush()
    },
    replace() {
      addressed({ type: 'replace', reason: 'bootstrap' })
      source.flush()
    },
  }
}

it('follows the viewer’s start, join and assignment records, and ignores a read marker', () => {
  const f = feed()
  f.put('issueProjections', 'task', {
    id: 'task',
    seq: 1,
    title: 'Alice’s task',
    stage: 'in_progress',
    audience: 'human',
    repoId: 'repo',
    assignee: 'mem_alice',
    createdAt: '2026-11-01',
    updatedAt: '2026-11-01',
    deps: [],
  })
  f.put('repos', 'repo', { id: 'repo', path: '/repo', prefix: 'POD' })
  f.replace()
  const handle = createWorklistPool(f.source.source, fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source)
  const issue = handle.pool.issueObject('task')
  const seen: boolean[] = []
  const stop = autorun(() => {
    seen.push(issue.inPersonalSet)
  })
  try {
    // Seeing the task: no row of the viewer's at all.
    expect(issue.inPersonalSet).toBe(false)
    // Opening it writes only the read marker.
    f.userState({ readAt: '2026-11-02', tuckedAt: null, pinned: false })
    expect(issue.inPersonalSet).toBe(false)
    expect(issue.readAt).toBe('2026-11-02')
    // Assigned to the viewer: the removable row puts it in the set.
    f.userState({
      readAt: '2026-11-02',
      tuckedAt: null,
      pinned: false,
      assignedAt: '2026-11-03',
      assignedBy: 'mem_alice',
    })
    expect(issue.inPersonalSet).toBe(true)
    expect(issue.assignedBy).toBe('mem_alice')
    // Dismissed: out again.
    f.userState({ readAt: '2026-11-02', tuckedAt: null, pinned: false })
    expect(issue.inPersonalSet).toBe(false)
    // Started an agent on it: in, and the reason is kept.
    f.userState({
      readAt: '2026-11-02',
      tuckedAt: null,
      pinned: false,
      joinedAt: '2026-11-04',
      joinedVia: 'start',
    })
    expect(issue.inPersonalSet).toBe(true)
    expect(issue.joinedVia).toBe('start')
    expect(seen).toEqual([false, true, false, true])
  } finally {
    stop()
    handle.dispose()
    f.source.dispose()
  }
})
