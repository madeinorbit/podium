import { describe, expect, it } from 'vitest'
import {
  counterChildren,
  leafTasks,
  rollUpTaskWords,
  type SessionWord,
  type SessionWordFacts,
  sessionWord,
  TASK_WORD_FILTERS,
  tallyTaskWords,
  type TaskWord,
  type TaskWordFacts,
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
    expect(sessionWord({ status: 'exited', stopReason: 'self', agentState: { phase: 'working' } })).toBe('done')
  })

  it('Idle: the turn finished and the process is alive or hibernated', () => {
    expect(sessionWord(live('idle', { agentState: { phase: 'idle', idle: { kind: 'done' } } }))).toBe('idle')
    expect(sessionWord(live('idle', { agentState: { phase: 'idle', idle: { kind: 'open_todos' } } }))).toBe('idle')
    expect(sessionWord({ status: 'hibernated', agentState: { phase: 'idle' } })).toBe('idle')
  })

  it('no phase evidence is Working only while the PTY is busy', () => {
    expect(sessionWord({ status: 'live', busy: true })).toBe('working')
    expect(sessionWord({ status: 'live', busy: false })).toBe('idle')
    expect(sessionWord(live('unknown'))).toBe('idle')
  })

  it('Needs you: a question, a permission request, or a pending offer', () => {
    expect(sessionWord(live('needs_user'))).toBe('needs-you')
    expect(sessionWord(live('idle', { agentState: { phase: 'idle', idle: { kind: 'question' } } }))).toBe('needs-you')
    expect(sessionWord(live('working', { offer: { message: 'merge?' } }))).toBe('needs-you')
    expect(sessionWord(live('idle'), { pendingInteractions: 1 })).toBe('needs-you')
    expect(sessionWord({ status: 'hibernated', agentState: { phase: 'needs_user' } })).toBe('needs-you')
  })

  it('an offer outlives the process; a question read from the phase does not', () => {
    expect(sessionWord({ status: 'exited', stopReason: 'self', offer: { message: 'x' } })).toBe('needs-you')
    expect(sessionWord({ status: 'exited', stopReason: 'self', agentState: { phase: 'needs_user' } })).toBe('done')
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
  sessions: (id) => NODES[id]?.sessions ?? [],
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
    expect((['error', 'needs-you', 'working'] as TaskWord[]).filter(f['needs-you'])).toEqual(['error', 'needs-you'])
    expect((['idle', 'blocked', 'done'] as TaskWord[]).filter(f.active)).toEqual(['idle'])
    expect((['blocked', 'not-started', 'idle'] as TaskWord[]).filter(f['up-next'])).toEqual(['blocked', 'not-started'])
  })
})
