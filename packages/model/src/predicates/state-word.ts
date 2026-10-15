/**
 * THE STATE WORDS — what a session and a task say they are doing, in one
 * vocabulary for the deck, the CLI and mobile (flight deck v6; decisions D5 and
 * D6 in `docs/design/flight-deck-v6/ANALYSIS.md`; POD-6110).
 *
 * Pure and structural, so the server's deck text view and every client compute
 * the same word from the same facts: a stored session row, a wire `SessionView`
 * and a client-graph model all satisfy {@link SessionWordFacts}.
 *
 * SESSION (D5): `working` · `idle` · `needs-you` · `error` · `done`.
 * TASK (D6), most urgent first: `error` > `needs-you` > `working` > `idle` >
 * `blocked` > `not-started`, and `done` only when the issue is closed. A task's
 * word rolls up from its own sessions AND its sub-issues' words, so a parent
 * always shows its most urgent descendant.
 */

import type { IdleVerdict } from '../entities/session'
import { issueAbandoned } from './active-work'
import { idleVerdictNeedsHuman } from './idle-verdict'
import { isFinished } from './issue-lifecycle'

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SESSION_WORDS = ['working', 'idle', 'needs-you', 'error', 'done'] as const
export type SessionWord = (typeof SESSION_WORDS)[number]

export const SESSION_WORD_LABEL: Readonly<Record<SessionWord, string>> = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  error: 'Error',
  done: 'Done',
}

/** The session facts the word reads. Every field is optional so a stored row,
 *  a wire view and a model can all be passed as they are. */
export interface SessionWordFacts {
  readonly status?: string | null
  readonly busy?: boolean | null
  readonly archived?: boolean | null
  readonly exitCode?: number | null
  readonly spawnFailure?: string | null
  readonly stopReason?: string | null
  readonly offer?: unknown
  readonly agentState?: {
    readonly phase?: string | null
    readonly idle?: { readonly kind?: IdleVerdict['kind'] | null } | null
  } | null
}

export interface SessionWordContext {
  /** The session's issue is closed. Closing clears Error and Needs you (D5). */
  readonly issueClosed?: boolean
  /** Unanswered pending interactions (permission requests, questions) for
   *  this session, from the `pendingInteractions` rows. */
  readonly pendingInteractions?: number
}

/**
 * Error (D5): any agent error, a crash, out-of-memory, or a failed start.
 *
 * The `errored` phase stays until the next turn replaces it, which is the "a new
 * turn clears Error" rule; nothing here needs to remember it. A crash is an exit
 * nobody asked for (`stopReason: 'exited'`) with a non-zero code: a requested
 * stop (`self`, `parent`, `forced`) is Done whatever code the process returned.
 */
export function sessionErrorFact(session: SessionWordFacts): boolean {
  if (session.agentState?.phase === 'errored') return true
  if (session.status !== 'exited') return false
  if (session.stopReason === 'oom') return true
  if (session.exitCode === -1 || session.spawnFailure) return true
  return session.stopReason === 'exited' && session.exitCode != null && session.exitCode !== 0
}

/**
 * Needs you (D5): a question, a permission request, or a pending offer.
 *
 * An offer and a pending interaction outlive the process (the user can still
 * answer them), so they count on an exited session too. A question read from
 * the phase only counts while the process can still take the answer: a
 * hibernated session keeps its last phase and resumes into it, an exited one
 * does not.
 */
export function sessionAsksFact(
  session: SessionWordFacts,
  context: SessionWordContext = {},
): boolean {
  if (session.offer) return true
  if ((context.pendingInteractions ?? 0) > 0) return true
  if (session.status === 'exited') return false
  const phase = session.agentState?.phase
  if (phase === 'needs_user') return true
  return phase === 'idle' && idleVerdictNeedsHuman(session.agentState?.idle?.kind ?? undefined)
}

/**
 * Working (D5): working, compacting, starting or reconnecting.
 *
 * A hibernated or exited process cannot be working, however stale its last
 * phase: a harness killed mid-turn freezes `working`. An agent with no phase
 * evidence (`unknown`, a shell) is working only while its PTY is busy.
 */
export function sessionWorkingFact(session: SessionWordFacts): boolean {
  const status = session.status
  if (status === 'starting' || status === 'reconnecting') return true
  if (status !== 'live') return false
  const phase = session.agentState?.phase
  if (phase === 'working' || phase === 'compacting') return true
  if (phase == null || phase === 'unknown') return session.busy === true
  return false
}

/**
 * One session's word (D5).
 *
 * Done: stopped by itself, its parent or the user, archived, or its issue is
 * closed. Closing outranks everything else, because it is the user's own "this
 * is finished" and nothing on the task may keep asking (POD-1072). Idle is what
 * is left: the turn is finished and the process is alive or hibernated.
 */
export function sessionWord(
  session: SessionWordFacts,
  context: SessionWordContext = {},
): SessionWord {
  if (context.issueClosed || session.archived) return 'done'
  if (sessionErrorFact(session)) return 'error'
  if (sessionAsksFact(session, context)) return 'needs-you'
  if (sessionWorkingFact(session)) return 'working'
  if (session.status === 'exited' || session.agentState?.phase === 'ended') return 'done'
  return 'idle'
}

/** Error and Needs you are the two words that carry colour and a dot. */
export function wordWantsAttention(word: SessionWord | TaskWord): boolean {
  return word === 'error' || word === 'needs-you'
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TASK_WORDS = [
  'error',
  'needs-you',
  'working',
  'idle',
  'blocked',
  'not-started',
  'done',
] as const
export type TaskWord = (typeof TASK_WORDS)[number]

export const TASK_WORD_LABEL: Readonly<Record<TaskWord, string>> = {
  error: 'Error',
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  blocked: 'Blocked',
  'not-started': 'Not started',
  done: 'Done',
}

/** The issue facts the task word reads. `blocked` is the feed's own verdict:
 *  open, with a `blocked-by` dependency that is not closed. A closed dependency
 *  counts as met whatever its close reason, cancelled included (D6). */
export interface TaskWordFacts {
  readonly type?: string | null
  readonly stage?: unknown
  readonly closedReason?: unknown
  readonly needsHuman?: boolean | null
  readonly blocked?: boolean | null
}

/** What a task rolls up from: its own sessions' words and its direct
 *  sub-issues' task words (phases included; they pass their children's
 *  urgency through). */
export interface TaskWordParts {
  readonly sessions?: Iterable<SessionWord>
  readonly children?: Iterable<TaskWord>
}

/** Stages that mean somebody already took the work up. */
const STARTED_STAGES: ReadonlySet<unknown> = new Set([
  'planning',
  'in_progress',
  'review',
  'shipping',
])

/**
 * One task's word (D6).
 *
 *  - Done only when the issue is closed; see {@link taskHidden} for the closes
 *    that also hide the row.
 *  - Error > Needs you > Working come from any session or sub-issue. An open
 *    decision and an explicit `needs-human` flag are Needs you. A task in
 *    `shipping` is Working: the system is landing it.
 *  - A live Idle (an idle session, or a sub-issue that reads Idle) outranks
 *    Blocked. Blocked is an unmet dependency (own or a sub-issue's) with
 *    nothing running.
 *  - A started task with nothing running reads Idle, never "stalled" or
 *    "retired": it had a session, a sub-issue moved, or its stage says it was
 *    taken up. Everything else is Not started.
 */
export function taskWord(task: TaskWordFacts, parts: TaskWordParts = {}): TaskWord {
  if (isFinished(task)) return 'done'
  let error = false
  let asks = task.type === 'decision' || task.needsHuman === true
  let working = task.stage === 'shipping'
  let idle = false
  let blocked = task.blocked === true
  let started = STARTED_STAGES.has(task.stage)
  for (const word of parts.sessions ?? []) {
    started = true
    if (word === 'error') error = true
    else if (word === 'needs-you') asks = true
    else if (word === 'working') working = true
    else if (word === 'idle') idle = true
  }
  for (const word of parts.children ?? []) {
    if (word === 'error') error = true
    else if (word === 'needs-you') asks = true
    else if (word === 'working') working = true
    else if (word === 'idle') idle = true
    else if (word === 'blocked') blocked = true
    if (word !== 'not-started' && word !== 'blocked') started = true
  }
  if (error) return 'error'
  if (asks) return 'needs-you'
  if (working) return 'working'
  if (idle) return 'idle'
  if (blocked) return 'blocked'
  return started ? 'idle' : 'not-started'
}

/** Cancelled, duplicate and superseded issues count as done and are hidden
 *  (D6). A done row that is not abandoned shows under "Show done". */
export function taskHidden(task: TaskWordFacts): boolean {
  return isFinished(task) && issueAbandoned(task)
}

// ---------------------------------------------------------------------------
// Trees: roll-up and counting
// ---------------------------------------------------------------------------

/** The tree the roll-up and the counts walk. `children` lists direct
 *  sub-issues; a callback rather than a map so a pool, a store read and a
 *  fixture all answer it without copying. */
export interface WordTree<Id> {
  readonly task: (id: Id) => TaskWordFacts | undefined
  readonly children: (id: Id) => Iterable<Id>
  readonly sessions: (id: Id) => Iterable<SessionWord>
}

/**
 * Every task word under (and including) `root`, children before parents.
 *
 * The server-side entry point: the deck text view and `epic-status` call this
 * with store reads. A client keeps one word per issue model instead and gets
 * the same answer from {@link taskWord}, one level at a time. A cycle in
 * the parent links reads the revisited issue as Not started rather than
 * recursing.
 */
export function rollUpTaskWords<Id>(root: Id, tree: WordTree<Id>): Map<Id, TaskWord> {
  const words = new Map<Id, TaskWord>()
  const visiting = new Set<Id>()
  const visit = (id: Id): TaskWord => {
    const known = words.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 'not-started'
    const task = tree.task(id)
    if (!task) return 'not-started'
    visiting.add(id)
    const children: TaskWord[] = []
    for (const child of tree.children(id)) if (tree.task(child)) children.push(visit(child))
    const word = taskWord(task, { sessions: tree.sessions(id), children })
    visiting.delete(id)
    words.set(id, word)
    return word
  }
  visit(root)
  return words
}

/** A phase groups work and is never itself a unit of work in counts (D1). */
const isPhase = (task: TaskWordFacts | undefined): boolean => task?.type === 'phase'

/**
 * The units a row counter counts: a task's direct sub-issues, looking through
 * phases, so a phase's own counter and its parent's both count tasks (D1).
 */
export function counterChildren<Id>(id: Id, tree: Pick<WordTree<Id>, 'task' | 'children'>): Id[] {
  const out: Id[] = []
  const seen = new Set<Id>([id])
  const walk = (parent: Id): void => {
    for (const child of tree.children(parent)) {
      if (seen.has(child)) continue
      seen.add(child)
      const task = tree.task(child)
      if (!task) continue
      if (isPhase(task)) walk(child)
      else out.push(child)
    }
  }
  walk(id)
  return out
}

/**
 * The units the gauge, the done line and the filter totals count: the leaves
 * under `root` (D1). A leaf is a non-phase issue with no non-phase issue below
 * it. The root itself is the mission, not a unit, unless it is the only issue.
 */
export function leafTasks<Id>(root: Id, tree: Pick<WordTree<Id>, 'task' | 'children'>): Id[] {
  const out: Id[] = []
  const seen = new Set<Id>()
  const walk = (id: Id): boolean => {
    let hasUnit = false
    for (const child of tree.children(id)) {
      if (seen.has(child)) continue
      seen.add(child)
      const task = tree.task(child)
      if (!task) continue
      const below = walk(child)
      if (isPhase(task)) {
        hasUnit ||= below
        continue
      }
      hasUnit = true
      if (!below) out.push(child)
    }
    return hasUnit
  }
  seen.add(root)
  if (!walk(root) && !isPhase(tree.task(root))) out.push(root)
  return out
}

/** The deck's filters, as predicates on a task word (v6 mockup). */
export const TASK_WORD_FILTERS = {
  all: (_word: TaskWord) => true,
  'needs-you': (word: TaskWord) => wordWantsAttention(word),
  active: (word: TaskWord) =>
    word === 'working' || word === 'idle' || word === 'error' || word === 'needs-you',
  'up-next': (word: TaskWord) => word === 'blocked' || word === 'not-started',
  done: (word: TaskWord) => word === 'done',
} as const satisfies Record<string, (word: TaskWord) => boolean>
export type TaskWordFilter = keyof typeof TASK_WORD_FILTERS

export type TaskWordTally = Record<TaskWord, number> & { readonly total: number }

/** How many of `ids` read each word. Feed it {@link leafTasks} for the gauge,
 *  the done line and the filter totals, or {@link counterChildren} for a row's
 *  `done/total`. Abandoned closes are counted as done (D6). */
export function tallyTaskWords<Id>(ids: Iterable<Id>, wordOf: (id: Id) => TaskWord): TaskWordTally {
  const tally = {
    error: 0,
    'needs-you': 0,
    working: 0,
    idle: 0,
    blocked: 0,
    'not-started': 0,
    done: 0,
    total: 0,
  }
  for (const id of ids) {
    tally[wordOf(id)] += 1
    tally.total += 1
  }
  return tally
}
