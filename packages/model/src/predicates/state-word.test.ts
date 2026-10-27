import { describe, expect, it } from 'vitest'
import { coordinatedSeat, type SeatSessionFacts } from './seat-attention'
import {
  coordinatedWord,
  counterChildren,
  leafTasks,
  rollUpTaskWords,
  type SeatWords,
  type SessionWord,
  type SessionWordFacts,
  seatWords,
  sessionWord,
  TASK_WORD_FILTERS,
  type TaskWord,
  type TaskWordFacts,
  tallyTaskWords,
  taskHidden,
  taskWord,
  type WordTree,
} from './state-word'

const live = (phase: string, over: Partial<SessionWordFacts> = {}): SessionWordFacts => ({
  status: 'live',
  agentState: { phase },
  ...over,
})

describe('sessionWord (D5)', () => {
  it('Working: working, compacting, starting or reconnecting', () => {
    expect(sessionWord(live('working'))).toBe('working')
    expect(sessionWord(live('compacting'))).toBe('working')
    expect(sessionWord({ status: 'starting' })).toBe('working')
    expect(sessionWord({ status: 'reconnecting', agentState: { phase: 'idle' } })).toBe('working')
  })

  it('a parked or exited process is never Working, however stale its phase', () => {
    expect(sessionWord({ status: 'hibernated', agentState: { phase: 'working' } })).toBe('idle')
    expect(
      sessionWord({ status: 'exited', stopReason: 'self', agentState: { phase: 'working' } }),
    ).toBe('done')
  })

  it('Idle: the turn finished and the process is alive or hibernated', () => {
    expect(
      sessionWord(live('idle', { agentState: { phase: 'idle', idle: { kind: 'done' } } })),
    ).toBe('idle')
    expect(
      sessionWord(live('idle', { agentState: { phase: 'idle', idle: { kind: 'open_todos' } } })),
    ).toBe('idle')
    expect(sessionWord({ status: 'hibernated', agentState: { phase: 'idle' } })).toBe('idle')
  })

  it('no phase evidence is Working only while the PTY is busy', () => {
    expect(sessionWord({ status: 'live', busy: true })).toBe('working')
    expect(sessionWord({ status: 'live', busy: false })).toBe('idle')
    expect(sessionWord(live('unknown'))).toBe('idle')
  })

  it('Needs you: a question, a permission request, or a pending offer', () => {
    expect(sessionWord(live('needs_user'))).toBe('needs-you')
    expect(
      sessionWord(live('idle', { agentState: { phase: 'idle', idle: { kind: 'question' } } })),
    ).toBe('needs-you')
    expect(sessionWord(live('working', { offer: { message: 'merge?' } }))).toBe('needs-you')
    expect(sessionWord(live('idle'), { pendingInteractions: 1 })).toBe('needs-you')
    expect(sessionWord({ status: 'hibernated', agentState: { phase: 'needs_user' } })).toBe(
      'needs-you',
    )
  })

  it('an offer outlives the process; a question read from the phase does not', () => {
    expect(sessionWord({ status: 'exited', stopReason: 'self', offer: { message: 'x' } })).toBe(
      'needs-you',
    )
    expect(
      sessionWord({ status: 'exited', stopReason: 'self', agentState: { phase: 'needs_user' } }),
    ).toBe('done')
  })

  it('Error: an agent error, a crash, out-of-memory, or a failed start', () => {
    expect(sessionWord(live('errored'))).toBe('error')
    expect(sessionWord({ status: 'exited', stopReason: 'exited', exitCode: 137 })).toBe('error')
    expect(sessionWord({ status: 'exited', stopReason: 'oom', exitCode: 0 })).toBe('error')
    expect(sessionWord({ status: 'exited', exitCode: -1 })).toBe('error')
    expect(sessionWord({ status: 'exited', spawnFailure: 'ENOENT' })).toBe('error')
  })

  it('Error outranks an offer: the session cannot act on it', () => {
    expect(sessionWord(live('errored', { offer: { message: 'x' } }))).toBe('error')
  })

  it('Done: stopped by itself, its parent or the user, whatever the exit code', () => {
    expect(sessionWord({ status: 'exited', stopReason: 'self', exitCode: 0 })).toBe('done')
    expect(sessionWord({ status: 'exited', stopReason: 'parent', exitCode: 143 })).toBe('done')
    expect(sessionWord({ status: 'exited', stopReason: 'forced', exitCode: 143 })).toBe('done')
    expect(sessionWord({ status: 'exited', stopReason: 'exited', exitCode: 0 })).toBe('done')
    expect(sessionWord(live('ended'))).toBe('done')
    expect(sessionWord({ ...live('working'), archived: true })).toBe('done')
  })

  it('closing the issue clears Error and Needs you', () => {
    expect(sessionWord(live('errored'), { issueClosed: true })).toBe('done')
    expect(sessionWord(live('needs_user', { offer: {} }), { issueClosed: true })).toBe('done')
  })
})

const open: TaskWordFacts = { type: 'task', stage: 'backlog' }

describe('taskWord (D6)', () => {
  it('ranks Error > Needs you > Working > Idle', () => {
    const all: SessionWord[] = ['idle', 'working', 'needs-you', 'error']
    expect(taskWord(open, { sessions: all })).toBe('error')
    expect(taskWord(open, { sessions: all.slice(0, 3) })).toBe('needs-you')
    expect(taskWord(open, { sessions: all.slice(0, 2) })).toBe('working')
    expect(taskWord(open, { sessions: ['idle', 'done'] })).toBe('idle')
  })

  it('Error ranks above Working (overturns POD-1601)', () => {
    expect(taskWord(open, { sessions: ['working', 'error'] })).toBe('error')
  })

  it('rolls up sub-issues: a parent shows its most urgent descendant', () => {
    expect(taskWord(open, { children: ['done', 'needs-you', 'working'] })).toBe('needs-you')
    expect(taskWord(open, { sessions: ['working'], children: ['error'] })).toBe('error')
    expect(taskWord(open, { children: ['blocked', 'not-started'] })).toBe('blocked')
  })

  it('Done only when the issue is closed, never because the children are', () => {
    expect(taskWord({ ...open, stage: 'done' }, { sessions: ['error'] })).toBe('done')
    expect(taskWord({ ...open, closedReason: 'cancelled' })).toBe('done')
    expect(taskWord(open, { children: ['done', 'done'] })).toBe('idle')
  })

  it('a phase is Done once all its sub-issues are, closed or not (POD-2178)', () => {
    const phase = { ...open, type: 'phase' }
    expect(taskWord(phase, { children: ['done', 'done'] })).toBe('done')
    expect(taskWord(phase, { sessions: ['idle'], children: ['done'] })).toBe('done')
    // An empty phase is a placeholder, not finished work.
    expect(taskWord(phase)).toBe('not-started')
    expect(taskWord(phase, { children: ['done', 'not-started'] })).toBe('idle')
    // A lead still working or asking keeps the phase open.
    expect(taskWord(phase, { sessions: ['needs-you'], children: ['done'] })).toBe('needs-you')
    expect(taskWord(phase, { sessions: ['working'], children: ['done'] })).toBe('working')
  })

  it('cancelled, duplicate and superseded count as done and are hidden', () => {
    for (const closedReason of ['cancelled', 'duplicate', 'superseded']) {
      expect(taskHidden({ ...open, stage: 'done', closedReason })).toBe(true)
    }
    expect(taskHidden({ ...open, stage: 'done', closedReason: 'done' })).toBe(false)
    expect(taskHidden({ ...open, closedReason: null })).toBe(false)
  })

  it('a started task with nothing running reads Idle, never stalled or retired', () => {
    expect(taskWord(open, { sessions: ['done'] })).toBe('idle')
    expect(taskWord({ ...open, stage: 'review' })).toBe('idle')
    expect(taskWord({ ...open, stage: 'in_progress' })).toBe('idle')
  })

  it('Blocked: an unmet dependency and nothing running', () => {
    expect(taskWord({ ...open, blocked: true })).toBe('blocked')
    expect(taskWord({ ...open, blocked: true }, { sessions: ['done'] })).toBe('blocked')
    expect(taskWord({ ...open, stage: 'review', blocked: true })).toBe('blocked')
    expect(taskWord({ ...open, blocked: true }, { sessions: ['idle'] })).toBe('idle')
    expect(taskWord({ ...open, blocked: true }, { sessions: ['working'] })).toBe('working')
  })

  it('an open decision and an explicit needs-human flag read Needs you', () => {
    expect(taskWord({ ...open, type: 'decision' })).toBe('needs-you')
    expect(taskWord({ ...open, type: 'decision', blocked: true })).toBe('needs-you')
    expect(taskWord({ ...open, type: 'decision', closedReason: 'done' })).toBe('done')
    expect(taskWord({ ...open, needsHuman: true })).toBe('needs-you')
  })

  it('review alone is not Needs you: the offer posted with it is', () => {
    expect(taskWord({ ...open, stage: 'review' }, { sessions: ['done'] })).toBe('idle')
    expect(taskWord({ ...open, stage: 'review' }, { sessions: ['needs-you'] })).toBe('needs-you')
  })

  it('shipping reads Working: the system is landing it', () => {
    expect(taskWord({ ...open, stage: 'shipping' })).toBe('working')
  })

  it('Not started: nothing taken up, nothing below', () => {
    expect(taskWord(open)).toBe('not-started')
    expect(taskWord({ ...open, stage: 'proposed' })).toBe('not-started')
    expect(taskWord(open, { children: ['not-started'] })).toBe('not-started')
  })
})

// mission
// ├── A (phase "Build")
// │   ├── A1  closed
// │   ├── A2  working session
// │   │   └── A2a  blocked
// │   └── A3  cancelled
// ├── B  needs-you session
// └── C  (phase, empty)
type Node = TaskWordFacts & { children?: string[]; sessions?: SessionWord[] }
const NODES: Record<string, Node> = {
  mission: { type: 'task', stage: 'in_progress', children: ['A', 'B', 'C'] },
  A: { type: 'phase', stage: 'backlog', children: ['A1', 'A2', 'A3'] },
  A1: { type: 'task', stage: 'done', closedReason: 'done', sessions: ['done'] },
  A2: { type: 'task', stage: 'in_progress', children: ['A2a'], sessions: ['working'] },
  A2a: { type: 'task', stage: 'backlog', blocked: true },
  A3: { type: 'task', stage: 'done', closedReason: 'cancelled' },
  B: { type: 'task', stage: 'in_progress', sessions: ['needs-you'] },
  C: { type: 'phase', stage: 'backlog' },
}
const TREE: WordTree<string> = {
  task: (id) => NODES[id],
  children: (id) => NODES[id]?.children ?? [],
  sessions: (id) =>
    (NODES[id]?.sessions ?? []).map((word) => ({ word, coordinator: word, delegate: word })),
}

describe('trees', () => {
  it('rolls up every word under the root', () => {
    const words = rollUpTaskWords('mission', TREE)
    expect(Object.fromEntries(words)).toEqual({
      A1: 'done',
      A2a: 'blocked',
      A2: 'working',
      A3: 'done',
      A: 'working',
      B: 'needs-you',
      C: 'not-started',
      mission: 'needs-you',
    })
  })

  it('survives a parent cycle', () => {
    const cyclic: WordTree<string> = {
      task: () => ({ type: 'task', stage: 'backlog' }),
      children: (id) => (id === 'x' ? ['y'] : ['x']),
      sessions: () => [],
    }
    expect(rollUpTaskWords('x', cyclic).get('x')).toBe('not-started')
  })

  it('counts leaves for the gauge, never phases or parents (D1)', () => {
    expect(leafTasks('mission', TREE).sort()).toEqual(['A1', 'A2a', 'A3', 'B'])
    expect(leafTasks('A2a', TREE)).toEqual(['A2a'])
    expect(leafTasks('C', TREE)).toEqual([])
  })

  it('counts direct children for a row counter, looking through phases (D1)', () => {
    expect(counterChildren('mission', TREE).sort()).toEqual(['A1', 'A2', 'A3', 'B'])
    expect(counterChildren('A', TREE)).toEqual(['A1', 'A2', 'A3'])
    expect(counterChildren('A2', TREE)).toEqual(['A2a'])
  })

  it('tallies words; abandoned closes count as done (D6)', () => {
    const words = rollUpTaskWords('mission', TREE)
    const tally = tallyTaskWords(leafTasks('mission', TREE), (id) => words.get(id) as TaskWord)
    expect(tally).toMatchObject({ total: 4, done: 2, blocked: 1, 'needs-you': 1 })
    const row = tallyTaskWords(counterChildren('A', TREE), (id) => words.get(id) as TaskWord)
    expect(`${row.done}/${row.total}`).toBe('2/3')
  })

  it('filters match the v6 mockup', () => {
    const f = TASK_WORD_FILTERS
    expect((['error', 'needs-you', 'working'] as TaskWord[]).filter(f['needs-you'])).toEqual([
      'error',
      'needs-you',
    ])
    expect((['idle', 'blocked', 'done'] as TaskWord[]).filter(f.active)).toEqual(['idle'])
    expect((['blocked', 'not-started', 'idle'] as TaskWord[]).filter(f['up-next'])).toEqual([
      'blocked',
      'not-started',
    ])
  })
})

describe('coordinated tasks (POD-2171)', () => {
  const idleDone = live('idle', { agentState: { phase: 'idle', idle: { kind: 'done' } } })
  const question = live('idle', { agentState: { phase: 'idle', idle: { kind: 'question' } } })
  const offered = { ...idleDone, offer: { message: 'Ready' } }
  const permission = live('needs_user')
  const errored = live('errored')
  const working = live('working')

  it('a delegate asks only when held at a prompt only a human can answer', () => {
    const asDelegate = (s: SessionWordFacts, pendingInteractions = 0) =>
      seatWords(s, {}, false, pendingInteractions).delegate
    expect(asDelegate(permission)).toBe('needs-you')
    expect(asDelegate(idleDone, 1)).toBe('needs-you')
    expect(asDelegate(errored)).toBe('error')
    expect(asDelegate(question)).toBe('idle')
    expect(asDelegate(offered)).toBe('idle')
    expect(asDelegate({ ...working, offer: { message: 'x' } })).toBe('working')
    expect(sessionWord(question)).toBe('needs-you')
  })

  // An epic run by `coord`; `reviewed` is a decision-free child whose agent
  // asked a question, `building` is a child whose delegate works.
  const tree = (
    seats: Record<string, SeatWords[]>,
    coordinated: (id: string) => boolean,
    extra: Record<string, TaskWordFacts & { children?: string[] }> = {},
  ): WordTree<string> => {
    const nodes: Record<string, TaskWordFacts & { children?: string[] }> = {
      epic: { type: 'task', stage: 'in_progress', children: ['reviewed', 'building'] },
      reviewed: { type: 'task', stage: 'review' },
      building: { type: 'task', stage: 'in_progress' },
      ...extra,
    }
    return {
      task: (id) => nodes[id],
      children: (id) => nodes[id]?.children ?? [],
      sessions: (id) => seats[id] ?? [],
      coordinated,
    }
  }
  const seats = (over: Partial<Record<string, SeatWords[]>> = {}): Record<string, SeatWords[]> =>
    ({
      epic: [seatWords(idleDone, {}, true)],
      reviewed: [seatWords(question)],
      building: [seatWords(working)],
      ...over,
    }) as Record<string, SeatWords[]>
  const epicWord = (t: WordTree<string>) => rollUpTaskWords('epic', t).get('epic')

  it('reads Working while a delegate works and a child agent asks the coordinator', () => {
    const t = tree(seats(), (id) => id === 'epic')
    expect(epicWord(t)).toBe('working')
    // The child's own row still shows its own session's question.
    expect(rollUpTaskWords('epic', t).get('reviewed')).toBe('needs-you')
  })

  it('without a live coordinator the child question rolls up as before', () => {
    expect(epicWord(tree(seats(), () => false))).toBe('needs-you')
  })

  it('escalates a delegate error and a permission prompt from anywhere below', () => {
    expect(epicWord(tree(seats({ building: [seatWords(errored)] }), (id) => id === 'epic'))).toBe(
      'error',
    )
    expect(
      epicWord(tree(seats({ building: [seatWords(permission)] }), (id) => id === 'epic')),
    ).toBe('needs-you')
  })

  it('asks for the coordinator itself, never for a delegate\u2019s question', () => {
    expect(
      epicWord(tree(seats({ epic: [seatWords(offered, {}, true)] }), (id) => id === 'epic')),
    ).toBe('needs-you')
    expect(
      epicWord(
        tree(
          seats({ epic: [seatWords(offered, {}, true), seatWords(question)] }),
          (id) => id === 'epic',
        ),
      ),
    ).toBe('needs-you')
    expect(
      epicWord(
        tree(
          seats({ epic: [seatWords(idleDone, {}, true), seatWords(question)] }),
          (id) => id === 'epic',
        ),
      ),
    ).toBe('working')
  })

  it('keeps a descendant\u2019s own requests on its own row', () => {
    const quiet = seats({ building: [seatWords(idleDone)], reviewed: [] })
    for (const building of [
      { type: 'task', stage: 'in_progress', needsHuman: true },
      { type: 'decision', stage: 'review' },
    ] as const) {
      const words = rollUpTaskWords(
        'epic',
        tree(quiet, (id) => id === 'epic', { building }),
      )
      expect(words.get('building')).toBe('needs-you')
      expect(words.get('epic')).toBe('idle')
      expect(epicWord(tree(quiet, () => false, { building }))).toBe('needs-you')
    }
  })

  it('reads a delegate\u2019s work apart from its suppressed offer, and counts open interactions', () => {
    const offeredWorking = { ...working, offer: { message: 'Ready' } }
    expect(seatWords(offeredWorking)).toEqual({
      word: 'needs-you',
      coordinator: 'needs-you',
      delegate: 'working',
      lead: false,
    })
    // The role words count open interactions even where the plain word is not given them.
    expect(seatWords(idleDone, {}, true, 1)).toMatchObject({
      word: 'idle',
      coordinator: 'needs-you',
    })
    expect(seatWords(idleDone, { pendingInteractions: 1 }).delegate).toBe('needs-you')
    const pending = seats({ building: [seatWords(idleDone, { pendingInteractions: 1 })] })
    expect(epicWord(tree(pending, (id) => id === 'epic'))).toBe('needs-you')
  })

  it('a nested coordinator asks on its own row and only escalates exceptions further up', () => {
    const nested = (sub: SessionWordFacts) =>
      tree(
        seats({ building: [seatWords(sub, {}, true), seatWords(working)] }),
        (id) => id === 'epic' || id === 'building',
      )
    expect(rollUpTaskWords('epic', nested(offered)).get('building')).toBe('needs-you')
    expect(epicWord(nested(offered))).toBe('working')
    expect(epicWord(nested(permission))).toBe('needs-you')
  })
})

describe('coordinatedSeat: one seat\u2019s whole verdict on a coordinated task (POD-2171)', () => {
  const at = (iso: string) => Date.parse(iso)
  const s = (over: Record<string, unknown>) =>
    ({ status: 'live', archived: false, ...over }) as SeatSessionFacts
  it('reads work apart from an offer, and asks only as the coordinator', () => {
    const offered = s({
      agentState: { phase: 'working', since: '2026-10-26T11:00:00Z' },
      offer: { createdAt: '2026-10-26T10:00:00Z' },
    })
    expect(coordinatedSeat(offered, 'delegate')).toMatchObject({
      asks: false,
      working: true,
      asksSince: null,
    })
    expect(coordinatedSeat(offered, 'coordinator')).toMatchObject({
      asks: true,
      working: true,
      asksSince: at('2026-10-26T10:00:00Z'),
    })
  })
  it('times a pending interaction from when it was asked, a prompt from its state, a crash from its stop', () => {
    const idle = s({
      agentState: { phase: 'idle', since: '2026-10-26T09:00:00Z', idle: { kind: 'done' } },
    })
    expect(
      coordinatedSeat(idle, 'delegate', { count: 1, since: at('2026-10-26T12:00:00Z') }),
    ).toMatchObject({ asks: true, asksSince: at('2026-10-26T12:00:00Z') })
    const prompt = s({
      agentState: { phase: 'needs_user', since: '2026-10-26T12:00:00Z' },
      offer: { createdAt: '2026-10-26T09:00:00Z' },
    })
    expect(coordinatedSeat(prompt, 'delegate').asksSince).toBe(at('2026-10-26T12:00:00Z'))
    const crash = s({
      status: 'exited',
      stopReason: 'oom',
      exitCode: 137,
      stoppedAt: '2026-10-26T11:30:00Z',
      agentState: { phase: 'working', since: '2026-10-26T08:00:00Z' },
    })
    expect(coordinatedSeat(crash, 'delegate')).toMatchObject({
      asks: true,
      asksSince: at('2026-10-26T11:30:00Z'),
      errorClass: 'oom',
      working: false,
    })
  })
  it('asks nothing on a closed task or from an archived seat', () => {
    const crash = s({ status: 'exited', stopReason: 'oom', exitCode: 137 })
    expect(coordinatedSeat(crash, 'delegate', undefined, false)).toMatchObject({
      asks: false,
      errorClass: null,
    })
    expect(coordinatedSeat({ ...crash, archived: true }, 'delegate')).toMatchObject({ asks: false })
  })
  it('a coordinator\u2019s question or pending interaction asks', () => {
    const question = s({
      agentState: { phase: 'idle', since: '2026-10-26T09:00:00Z', idle: { kind: 'question' } },
    })
    expect(coordinatedSeat(question, 'coordinator').asks).toBe(true)
    expect(coordinatedSeat(question, 'delegate').asks).toBe(false)
  })
})

describe('the verdict is unambiguous (review round 3)', () => {
  const stale = [
    { status: 'reconnecting', agentState: { phase: 'idle', idle: { kind: 'done' } } },
    { status: 'starting', agentState: { phase: 'idle', idle: { kind: 'open_todos' } } },
    { status: 'starting', agentState: { phase: 'ended' } },
  ] as const
  it('a starting or reconnecting seat with a stale finished phase is working, never also done', () => {
    for (const session of stale) {
      const seat = coordinatedSeat(session as SeatSessionFacts, 'delegate')
      expect(seat).toMatchObject({ working: true, done: false })
      expect(coordinatedWord(seat)).toBe('working')
      expect(seatWords(session as SessionWordFacts).delegate).toBe('working')
    }
  })
  it('role words translate the verdict with the session word\u2019s precedence', () => {
    const exited = { status: 'exited', stopReason: 'self', exitCode: 0 } as SessionWordFacts
    expect(seatWords(exited, {}, false, 1)).toMatchObject({ word: 'done', delegate: 'needs-you' })
    expect(seatWords(exited, { issueClosed: true }, false, 1).delegate).toBe('done')
  })
})
