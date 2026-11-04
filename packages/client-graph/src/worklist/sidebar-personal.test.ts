/**
 * THE SIDEBAR IS PERSONAL (POD-6294, MU-09; design §2.2).
 *
 * Bob's client, through the production feed. Every member reads every task, so
 * Alice's tasks arrive in Bob's pool too; his sidebar still holds only his
 * personal set (POD-6290): what he started or joined, and what was assigned to
 * him and not dismissed. A row he holds on someone else's task carries its
 * owner. Until the roster shows a second member, and on a one-member instance,
 * the sidebar is exactly what it was.
 */
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { assigneeFacet, type IssuesAssignedTo } from '@podium/client-core/values'
import { asIssueId, asUserId, issueUserStateRowId } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { EMPTY_PENDING } from '../../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from '../create'
import type { BoardOptions } from '../issue-board-schema'
import { createIssueBoardSource } from '../issue-board-source'
import { memberRoster } from '../member-roster'
import { fixedLocals } from '../shared/locals-source'
import { createRowSource } from '../shared/row-source'
import { LOADING } from './rollup'
import { sidebarView } from './sidebar'
import { worklistView } from './view-model'

const BOB = 'mem_bob'
const ALICE = 'mem_alice'
const now = Date.parse('2026-11-04T12:00:00Z')
const stamp = new Date(now - 60_000).toISOString()
const repoId = 'repo'
type Row = Readonly<Record<string, unknown>>

const member = (id: string, displayName: string) => ({
  id,
  displayName,
  email: null,
  role: id === ALICE ? 'admin' : 'member',
  disabledAt: null,
})

function fixture() {
  const tables = new Map<ReplicaKind, Map<string, Row>>()
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const put = (kind: ReplicaKind, id: string, row: Row) => {
    const table = tables.get(kind) ?? new Map<string, Row>()
    tables.set(kind, table)
    table.set(id, row)
  }
  put('repos', repoId, { id: repoId, prefix: 'POD', repoPath: '/code/repo', name: 'repo' })
  const tasks: [string, number, string][] = [
    ['alice-task', 1, ALICE], // Alice's own; Bob has no record on it.
    ['bob-task', 2, BOB], // Bob's own, started by him.
    ['alice-joined', 3, ALICE], // Alice's, Bob started an agent on it.
    ['assigned-to-bob', 4, BOB], // Alice assigned it to Bob.
  ]
  for (const [id, seq, assignee] of tasks)
    put('issueProjections', id, {
      id,
      repoId,
      seq,
      title: id,
      stage: 'in_progress',
      audience: 'human',
      assignee,
      createdAt: stamp,
      updatedAt: stamp,
      deps: [],
    })
  const state = (issue: string, value: Row) =>
    put('issueUserStates', issueUserStateRowId(asUserId(BOB), asIssueId(issue)), {
      userId: BOB,
      entityId: issue,
      readAt: null,
      tuckedAt: null,
      pinned: false,
      ...value,
    })
  state('bob-task', { joinedAt: stamp, joinedVia: 'start' })
  state('alice-joined', { joinedAt: stamp, joinedVia: 'start' })
  state('assigned-to-bob', { assignedAt: stamp, assignedBy: ALICE })
  // Bob opened Alice's task: a read marker only.
  state('alice-task', { readAt: stamp })
  const source = createRowSource(
    { principal: { userId: BOB }, readLocal: () => [], onLocals: () => () => {} },
    {
      row: (kind, id) => tables.get(kind)?.get(id),
      rows: (kind) => [...(tables.get(kind)?.values() ?? [])],
      subscribeAddressedBatch(listener) {
        addressed = listener
        return () => {}
      },
    },
    { pending: EMPTY_PENDING },
  )
  const handle = createWorklistPool(
    source.source,
    fixedLocals({ selectedIssueId: null, coarseNow: now }).source,
  )
  return {
    pool: handle.pool,
    rowIds: () =>
      sidebarView(handle.pool)
        .sections()
        .bands.flatMap((band) => band.rowIds)
        .sort(),
    roster: (members: ReturnType<typeof member>[]) =>
      memberRoster(handle.pool).read(async () => ({ members, currentMemberId: BOB })),
    dismiss(issue: string) {
      state(issue, {})
      addressed({
        type: 'update',
        rows: [
          { kind: 'issueUserStates', id: issueUserStateRowId(asUserId(BOB), asIssueId(issue)) },
        ],
      })
      source.flush()
    },
    dispose() {
      handle.dispose()
      source.dispose()
    },
  }
}

it('holds only the viewer’s personal set once the instance has two members, with owner badges', async () => {
  const f = fixture()
  const seen: string[][] = []
  const stop = autorun(() => {
    seen.push(f.rowIds())
  })
  try {
    // Before the roster answers: the former rule, every task a row.
    expect(f.rowIds()).toEqual(['alice-joined', 'alice-task', 'assigned-to-bob', 'bob-task'])
    await f.roster([member(ALICE, 'Alice'), member(BOB, 'Bob')])
    // Alice's task, only seen and opened, is not Bob's.
    expect(f.rowIds()).toEqual(['alice-joined', 'assigned-to-bob', 'bob-task'])
    const worklist = worklistView(f.pool)
    const badge = (id: string) => worklist.row(f.pool.issueObject(id)).ownerBadge
    expect(badge('alice-joined')).toBe(ALICE)
    expect(badge('bob-task')).toBeUndefined()
    expect(badge('assigned-to-bob')).toBeUndefined()
    // Dismissing the "assigned to you" row takes the task out.
    f.dismiss('assigned-to-bob')
    expect(f.rowIds()).toEqual(['alice-joined', 'bob-task'])
    expect(seen.at(-1)).toEqual(['alice-joined', 'bob-task'])
  } finally {
    stop()
    f.dispose()
  }
})

it('keeps the former sidebar on a one-member instance', async () => {
  const f = fixture()
  try {
    await f.roster([member(BOB, 'Bob')])
    expect(f.rowIds()).toEqual(['alice-joined', 'alice-task', 'assigned-to-bob', 'bob-task'])
    expect(worklistView(f.pool).row(f.pool.issueObject('alice-joined')).ownerBadge).toBeUndefined()
  } finally {
    f.dispose()
  }
})

it('lists Alice’s tasks on Bob’s Tasks board with All users, and his sidebar does not change', async () => {
  const f = fixture()
  const board = createIssueBoardSource(f.pool)
  const sidebar: string[][] = []
  const stop = autorun(() => {
    sidebar.push(f.rowIds())
  })
  const listed = (assignedTo: IssuesAssignedTo) => {
    const roster = memberRoster(f.pool)
    const assignee = assigneeFacet(assignedTo, {
      shared: roster.shared,
      viewer: roster.currentMemberId,
    })
    const options: BoardOptions = {
      display: { layout: 'board', ordering: 'priority', showAgentTasks: false },
      filter: assignee ? { assignee } : {},
      expanded: [],
      isMobile: false,
      windowed: false,
      openIssueId: null,
      now,
    }
    const data = board.board(options)
    if (data === LOADING || !data) throw new Error('board not loaded')
    return [...data.activeIds].sort()
  }
  try {
    await f.roster([member(ALICE, 'Alice'), member(BOB, 'Bob')])
    const personal = ['alice-joined', 'assigned-to-bob', 'bob-task']
    expect(f.rowIds()).toEqual(personal)
    const before = sidebar.length
    // Me, the default: Bob's own tasks only.
    expect(listed('me')).toEqual(['assigned-to-bob', 'bob-task'])
    // All users: Alice's tasks too, including the one Bob only opened.
    expect(listed('all')).toEqual(['alice-joined', 'alice-task', 'assigned-to-bob', 'bob-task'])
    // A named member.
    expect(listed(ALICE)).toEqual(['alice-joined', 'alice-task'])
    // The sidebar never moved while the board's filter changed.
    expect(f.rowIds()).toEqual(personal)
    expect(sidebar.length).toBe(before)
  } finally {
    stop()
    board.dispose()
    f.dispose()
  }
})
