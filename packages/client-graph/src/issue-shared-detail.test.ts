/**
 * THE SHARED HALF OF A TASK PAGE, AND MEMBER NAMES (POD-6295).
 *
 * Bob's pool on a three-member instance holds Alice's task. The shared-detail
 * store reads what Bob may do, the D13 summaries and the collaborators once
 * while the page holds it, and lets go when the page closes. Two members who
 * share a display name are told apart by a tag from their member ids, never by
 * their emails.
 */
import type { ReplicaKind } from '@podium/client-core/replica'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from './create'
import { issueSharedDetail, otherMembersSessions } from './issue-shared-detail'
import { memberRoster } from './member-roster'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'

const BOB = 'mem_bob'
const stamp = '2026-11-04T11:59:00.000Z'
type Row = Readonly<Record<string, unknown>>

const member = (id: string, displayName: string, email: string | null = null) => ({
  id,
  displayName,
  email,
  role: 'member',
  disabledAt: null,
})

function fixture() {
  const tables = new Map<ReplicaKind, Map<string, Row>>()
  const put = (kind: ReplicaKind, id: string, row: Row) => {
    const table = tables.get(kind) ?? new Map<string, Row>()
    tables.set(kind, table)
    table.set(id, row)
  }
  put('repos', 'repo', { id: 'repo', prefix: 'POD', repoPath: '/code/repo', name: 'repo' })
  put('issueProjections', 'alice-task', {
    id: 'alice-task',
    repoId: 'repo',
    seq: 1,
    title: 'Invite flow copy',
    stage: 'in_progress',
    audience: 'human',
    assignee: 'mem_alice',
    createdAt: stamp,
    updatedAt: stamp,
    deps: [],
  })
  const source = createRowSource(
    { principal: { userId: BOB } },
    {
      row: (kind, id) => tables.get(kind)?.get(id),
      rows: (kind) => [...(tables.get(kind)?.values() ?? [])],
      subscribeAddressedBatch: () => () => {},
    },
    { pending: EMPTY_PENDING },
  )
  const handle = createWorklistPool(
    source.source,
    fixedLocals({ selectedIssueId: null, coarseNow: Date.parse(stamp) }).source,
  )
  return handle.pool
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('member names', () => {
  it('tags two members who share a display name with their member ids, never their emails', async () => {
    const pool = fixture()
    const roster = memberRoster(pool)
    await roster.read(async () => ({
      members: [
        member('mem_alice', 'Alice Martin', 'alice@example.com'),
        member('mem_sam1a2b', 'Sam', 'sam.one@example.com'),
        member('mem_sam9z8y', 'Sam', 'sam.two@example.com'),
      ],
      currentMemberId: BOB,
    }))
    expect(roster.nameOf('mem_alice')).toBe('Alice Martin')
    const one = roster.nameOf('mem_sam1a2b')
    const two = roster.nameOf('mem_sam9z8y')
    expect(one).toBe('Sam (1a2b)')
    expect(two).toBe('Sam (9z8y)')
    expect(`${one} ${two}`).not.toContain('@')
  })
})

describe('the shared-detail store', () => {
  it('reads allowed actions, summaries and collaborators while held, and lets go on close', async () => {
    const pool = fixture()
    const detail = issueSharedDetail(pool, 'alice-task')
    const ports = {
      get: vi.fn(async () => ({
        allowed: { reassign: true, edit: true, restore: true, comment: true },
        sessionSummaries: [
          { owner: 'mem_alice', title: 'Invite flow copy', state: 'live' as const },
          { owner: BOB, title: 'Bob’s review', state: 'idle' as const },
        ],
      })),
      collaborators: vi.fn(async () => [
        { userId: 'mem_alice', joinedAt: stamp, via: 'start' },
        { userId: 'mem_carol', joinedAt: stamp, via: 'join' },
      ]),
    }
    const release = detail.retain(ports)
    // A second section of the same page shares the one read.
    const releaseAgain = detail.retain(ports)
    await settle()
    expect(ports.get).toHaveBeenCalledTimes(1)
    expect(detail.allowed).toEqual({ reassign: true, edit: true, restore: true, comment: true })
    expect(detail.collaboratorIds).toEqual(['mem_alice', 'mem_carol'])
    expect(otherMembersSessions(detail.sessionSummaries, BOB)).toEqual([
      { owner: 'mem_alice', title: 'Invite flow copy', state: 'live' },
    ])
    release()
    expect(detail.allowed).toBeDefined()
    releaseAgain()
    expect(detail.allowed).toBeUndefined()
  })

  it('knows no collaborators on an older server without the read', async () => {
    const pool = fixture()
    const detail = issueSharedDetail(pool, 'alice-task')
    const release = detail.retain({
      get: async () => ({}),
      collaborators: async () => {
        throw new Error('No "query"-procedure on path "issues.collaborators"')
      },
    })
    await settle()
    expect(detail.collaboratorIds).toEqual([])
    expect(detail.allowed).toBeUndefined()
    release()
  })

  it('shows no summaries before the reader is known', () => {
    expect(
      otherMembersSessions([{ owner: 'mem_alice', title: 't', state: 'live' }], undefined),
    ).toEqual([])
  })
})
