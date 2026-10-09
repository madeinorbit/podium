import { MobxPool } from '@podium/client-graph/pool'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { workingIssueRef } from '@/lib/ref-miniview'
import { sessionForIssue, sessionWorkingIssueRef } from '@/lib/ref-miniview.before.test.fixture'
import {
  readIssueDisplayRef,
  readRefTarget,
  readSessionDisplayRef,
  readSessionTarget,
} from './ref-miniview-readers'
import { readRefMiniview } from './ref-miniview-readers.before.test.fixture'

// POD-5831: the card's "Go to session" target, parent label and working label
// now come from the shared issue/session models. The old catalog answers stay
// in the before fixtures and every answer is compared on the same pool.
const stamp = (minute: number) => `2026-10-09T00:${String(minute).padStart(2, '0')}:00Z`
type Row = Record<string, unknown>
const issue = (id: string, seq: number, patch: Row = {}): Row => ({
  id, seq, title: `Task ${seq}`, repoId: 'repo', repoPath: '/synthetic', stage: 'in_progress',
  createdAt: stamp(0), updatedAt: stamp(0), ...patch,
})
/** A seat's birth ref is stored as fields; the display ref spells them. */
function refFields(displayRef: string): Row {
  const born = /^POD-(\d+)-([A-Z]+)$/.exec(displayRef), draft = /^POD-DRAFT-(\d+)$/.exec(displayRef)
  return born ? { refRepoId: 'repo', refSeq: Number(born[1]), refLetter: born[2] }
    : draft ? { refRepoId: 'repo', refDraft: Number(draft[1]) } : {}
}
const seat = (sessionId: string, issueId: string | undefined, patch: Row = {}): Row => {
  const displayRef = (patch.displayRef as string | undefined) ?? `POD-1-${sessionId}`
  return {
    sessionId, issueId, displayRef, ...refFields(displayRef), cwd: '/synthetic', agentKind: 'codex',
    status: 'live', title: sessionId, createdAt: stamp(0), lastActiveAt: stamp(1), ...patch,
  }
}

function poolOf(issues: Row[], sessions: Row[]) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp(0)) })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'worktree',
        id: '/synthetic',
        value: { path: '/synthetic', repoId: 'repo', repoPath: '/synthetic', prefix: 'POD', repoName: 'Synthetic' },
      },
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id as string, value })),
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId as string, value })),
    ] as never,
  })
  return pool
}

/** The old card: its chain world, then the catalog pick. */
function oldTarget(pool: MobxPool, ref: string) {
  const card = readRefMiniview(pool, ref)
  const own = card.issues[0]
  const target = own ? sessionForIssue(own, card.issues, card.sessions) : null
  return target
    ? { sessionId: target.session.sessionId as string, sessionRef: target.session.displayRef ?? '',
        viaId: target.via.id as string, viaRef: target.via.displayRef ?? '' }
    : null
}
function newTarget(pool: MobxPool, ref: string) {
  const resolved = readRefTarget(pool, ref).target
  if (resolved?.kind !== 'issue') return null
  const target = readSessionTarget(pool, resolved.issue.id)
  return target && {
    sessionId: target.sessionId as string, sessionRef: readSessionDisplayRef(pool, target.sessionId),
    viaId: target.viaId, viaRef: readIssueDisplayRef(pool, target.viaId),
  }
}
function oldParentRef(pool: MobxPool, ref: string) {
  const card = readRefMiniview(pool, ref)
  const parentId = card.issues[0]?.parentId
  return (parentId ? card.issues.find((row) => row.id === parentId)?.displayRef : undefined) ?? ''
}
function newParentRef(pool: MobxPool, ref: string) {
  const resolved = readRefTarget(pool, ref).target
  const parentId = resolved?.kind === 'issue' ? resolved.issue.parentId : undefined
  return parentId ? readIssueDisplayRef(pool, parentId) : ''
}

const tree = [
  issue('root', 1),
  issue('mid', 2, { parentId: 'root' }),
  issue('leaf', 3, { parentId: 'mid' }),
]
const SCENARIOS: { name: string; issues: Row[]; sessions: Row[]; ref: string }[] = [
  { name: 'own seat beats the parent', issues: tree, ref: 'POD-3',
    sessions: [seat('own', 'leaf'), seat('up', 'mid', { lastActiveAt: stamp(9) })] },
  { name: 'a sessionless subtask inherits its parent', issues: tree, ref: 'POD-3',
    sessions: [seat('up', 'mid')] },
  { name: 'the walk reaches the grandparent', issues: tree, ref: 'POD-3',
    sessions: [seat('top', 'root')] },
  { name: 'the coordinator beats a more recent member',
    issues: [issue('one', 1, { coordinatorSessionId: 'lead' })], ref: 'POD-1',
    sessions: [seat('lead', 'one', { lastActiveAt: stamp(1) }), seat('late', 'one', { lastActiveAt: stamp(5) })] },
  { name: 'an exited coordinator falls back to the most recent',
    issues: [issue('one', 1, { coordinatorSessionId: 'lead' })], ref: 'POD-1',
    sessions: [seat('lead', 'one', { status: 'exited' }), seat('a', 'one', { lastActiveAt: stamp(3) }),
      seat('b', 'one', { lastActiveAt: stamp(4) })] },
  { name: 'a recency tie keeps the collapse order', issues: [issue('one', 1)], ref: 'POD-1',
    sessions: [seat('s-b', 'one'), seat('s-a', 'one'), seat('s-c', 'one')] },
  { name: 'exited, archived and shell seats are passed over', issues: tree, ref: 'POD-3',
    sessions: [seat('gone', 'leaf', { status: 'exited' }), seat('retired', 'leaf', { archived: true }),
      seat('shell', 'leaf', { agentKind: 'shell' }), seat('up', 'mid')] },
  { name: 'a headless seat still counts, as before', issues: [issue('one', 1)], ref: 'POD-1',
    sessions: [seat('quiet', 'one', { headless: true })] },
  { name: 'a parked resume twin folds away', issues: [issue('one', 1)], ref: 'POD-1',
    sessions: [
      seat('twin-old', 'one', { status: 'hibernated', resume: { kind: 'claude', value: 'r' }, lastActiveAt: stamp(9) }),
      seat('twin-new', 'one', { status: 'hibernated', resume: { kind: 'claude', value: 'r' }, lastActiveAt: stamp(2) }),
    ] },
  { name: 'a seat on another task is not this task’s', issues: [issue('one', 1), issue('two', 2)],
    ref: 'POD-1', sessions: [seat('elsewhere', 'two')] },
  { name: 'nothing in the chain has run', issues: tree, ref: 'POD-3', sessions: [] },
  { name: 'a cyclic chain terminates',
    issues: [issue('a', 1, { parentId: 'b' }), issue('b', 2, { parentId: 'a' })], ref: 'POD-1', sessions: [] },
  { name: 'a cyclic chain still finds the other side',
    issues: [issue('a', 1, { parentId: 'b' }), issue('b', 2, { parentId: 'a' })], ref: 'POD-1',
    sessions: [seat('b-seat', 'b')] },
]

describe('reference card target parity (POD-5831)', () => {
  for (const scenario of SCENARIOS)
    it(scenario.name, () => {
      const pool = poolOf(scenario.issues, scenario.sessions)
      try {
        const before = oldTarget(pool, scenario.ref)
        expect(newTarget(pool, scenario.ref)).toEqual(before)
        expect(newParentRef(pool, scenario.ref)).toBe(oldParentRef(pool, scenario.ref))
      } finally {
        pool.dispose()
      }
    })

  it('names a target in most scenarios, so the comparison is not vacuous', () => {
    const named = SCENARIOS.filter((scenario) => {
      const pool = poolOf(scenario.issues, scenario.sessions)
      try {
        return oldTarget(pool, scenario.ref) !== null
      } finally {
        pool.dispose()
      }
    })
    expect(named.length).toBeGreaterThanOrEqual(9)
  })

  it('fails when the new answer is wrong', () => {
    const scenario = SCENARIOS.find((row) => row.name === 'the coordinator beats a more recent member')!
    const pool = poolOf(scenario.issues, scenario.sessions)
    try {
      const before = oldTarget(pool, scenario.ref)
      const wrong = { ...newTarget(pool, scenario.ref)!, sessionId: 'late', sessionRef: 'POD-1-late' }
      expect(() => expect(wrong).toEqual(before)).toThrow()
      const inherited = SCENARIOS.find((row) => row.name === 'a sessionless subtask inherits its parent')!
      const tree = poolOf(inherited.issues, inherited.sessions)
      try {
        const own = { ...newTarget(tree, inherited.ref)!, viaId: 'leaf', viaRef: 'POD-3' }
        expect(() => expect(own).toEqual(oldTarget(tree, inherited.ref))).toThrow()
      } finally {
        tree.dispose()
      }
    } finally {
      pool.dispose()
    }
  })

  it('matches the old working label of a re-homed session', () => {
    const pool = poolOf(
      [issue('born', 1), issue('now', 2)],
      [seat('moved', 'now', { displayRef: 'POD-1-A' }), seat('home', 'born', { displayRef: 'POD-1-B' }),
        seat('draft', 'now', { displayRef: 'POD-DRAFT-3' }), seat('loose', undefined, { displayRef: 'POD-DRAFT-4' })],
    )
    try {
      for (const ref of ['POD-1-A', 'POD-1-B', 'POD-DRAFT-3', 'POD-DRAFT-4']) {
        const card = readRefMiniview(pool, ref)
        const session = card.sessions[0]
        if (!session) throw new Error(`${ref} did not resolve in the old reader`)
        const before = sessionWorkingIssueRef(session, card.issues)
        const resolved = readRefTarget(pool, ref).target
        if (resolved?.kind !== 'session') throw new Error(`${ref} did not resolve`)
        const issueId = resolved.session.issueId
        expect(workingIssueRef(resolved.session.displayRef, issueId ? readIssueDisplayRef(pool, issueId) : '')).toBe(before)
      }
      expect(workingIssueRef('POD-1-A', 'POD-1')).toBeNull()
      expect(() => expect(workingIssueRef('POD-1-A', 'POD-2')).toBe(null)).toThrow()
    } finally {
      pool.dispose()
    }
  })
})

describe('reference card updates (POD-5831)', () => {
  for (const scale of [1, 4])
    it(`prepares nothing for an unrelated session and follows displayed changes at ${scale}x`, () => {
      const others = Array.from({ length: 64 * scale }, (_, n) => n)
      const pool = poolOf(
        [...tree, ...others.map((n) => issue(`other-${n}`, 100 + n))],
        [seat('up', 'mid', { displayRef: 'POD-2-A' }), seat('moved', 'leaf', { displayRef: 'POD-1-A' }),
          ...others.map((n) => seat(`busy-${n}`, `other-${n}`))],
      )
      const runs = { card: 0, target: 0, parent: 0, working: 0, old: 0 }
      const seen: { title?: string; target?: string | null; working?: string | null } = {}
      const stops = [
        autorun(() => {
          const value = readRefTarget(pool, 'POD-3').target
          seen.title = value?.kind === 'issue' ? value.issue.title : undefined
          runs.card++
        }),
        autorun(() => {
          seen.target = readSessionTarget(pool, 'leaf')?.sessionId ?? null
          runs.target++
        }),
        autorun(() => {
          readIssueDisplayRef(pool, 'mid')
          runs.parent++
        }),
        autorun(() => {
          const value = readRefTarget(pool, 'POD-1-A').target
          const issueId = value?.kind === 'session' ? value.session.issueId : undefined
          seen.working = workingIssueRef('POD-1-A', issueId ? readIssueDisplayRef(pool, issueId) : '')
          runs.working++
        }),
        autorun(() => {
          oldTarget(pool, 'POD-3')
          runs.old++
        }),
      ]
      try {
        expect(seen).toEqual({ title: 'Task 3', target: 'moved', working: 'POD-3' })
        const settled = { ...runs }
        // Unrelated sessions: renamed, heartbeating, finishing.
        for (const n of others.slice(0, 8))
          pool.apply({ type: 'update', rows: [
            { kind: 'session', id: `busy-${n}`, value: seat(`busy-${n}`, `other-${n}`, {
              title: 'Renamed', lastActiveAt: stamp(30), status: n % 2 ? 'exited' : 'live' }) },
          ] as never })
        expect({ ...runs, old: settled.old }).toEqual(settled)
        const oldUnrelated = runs.old - settled.old
        // The target's own heartbeat keeps its answer: nothing redraws.
        pool.apply({ type: 'update', rows: [
          { kind: 'session', id: 'moved', value: seat('moved', 'leaf', { displayRef: 'POD-1-A', lastActiveAt: stamp(40) }) },
        ] as never })
        expect(runs.target).toBe(settled.target)
        // A displayed title.
        pool.apply({ type: 'update', rows: [
          { kind: 'issue', id: 'leaf', value: issue('leaf', 3, { parentId: 'mid', title: 'Renamed task' }) },
        ] as never })
        expect(seen.title).toBe('Renamed task')
        // The target moves: its seat leaves the task, the parent's covers it.
        pool.apply({ type: 'update', rows: [
          { kind: 'session', id: 'moved', value: seat('moved', 'root', { displayRef: 'POD-1-A', lastActiveAt: stamp(40) }) },
        ] as never })
        expect(seen.target).toBe('up')
        // The working label follows the re-home.
        expect(seen.working).toBe(null)
        expect(runs.parent).toBe(settled.parent)
        console.info(`POD-5831 card re-runs from 8 unrelated session changes at ${scale}x`, {
          new: 0,
          old: oldUnrelated,
        })
      } finally {
        for (const stop of stops) stop()
        pool.dispose()
      }
    })
})
