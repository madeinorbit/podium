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
 * always shows its most urgent descendant, except that under a live
 * coordinator only exceptions ask (POD-2171, {@link taskWords}).
 */

import type { IdleVerdict } from '../entities/session'
import { issueAbandoned } from './active-work'
import { isFinished } from './issue-lifecycle'
import {
  type CoordinatedSeat,
  coordinatedSeat,
  seatAsks,
  seatAttention,
  sessionErrorFact,
  sessionWorkingFact,
} from './seat-attention'

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
  /** The machine's daemon link is down right now (derived; see SeatSessionFacts). */
  readonly reconnecting?: boolean | null
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
 * Needs you (D5): a question, a permission request, or a pending offer. The
 * facts and the policy are `seatAttention` and `seatAsks`: an offer and a
 * pending interaction outlive the process, a question read from the phase
 * counts only while the process can still take the answer.
 */
export function sessionAsksFact(
  session: SessionWordFacts,
  context: SessionWordContext = {},
): boolean {
  return seatAsks(seatAttention(session, context.pendingInteractions))
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
  /** The word as the task shows a coordinated ancestor (POD-2171): its own
   *  requests are for the coordinator, so they do not ask. */
  readonly delegated?: boolean
}

/**
 * The task's OWN request to a human, before its sessions: a decision-type issue
 * or the explicit needs-human flag. An open review is not one here: the offer
 * posted with it is (the deck's rule; the sidebar row differs, see
 * `seat-attention.ts`). A closed task asks nothing of its own.
 */
export function taskOwnAsks(task: TaskWordFacts): boolean {
  if (isFinished(task)) return false
  return task.type === 'decision' || task.needsHuman === true
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
 *    that also hide the row. A phase only groups (D1, POD-2178): it is also
 *    Done once it has sub-issues, all of them Done, and nothing on it (a
 *    session, its own request, a `shipping` stage) errs, asks or works,
 *    whether or not anyone closed the phase itself.
 *  - Error > Needs you > Working come from any session or sub-issue. The
 *    task's own requests ({@link taskOwnAsks}: an open decision, an explicit
 *    `needs-human` flag) are Needs you, except in its `delegated` word. A task in `shipping` is Working: the system is
 *    landing it.
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
  let asks = false
  let working = task.stage === 'shipping'
  let idle = false
  let blocked = task.blocked === true
  let started = STARTED_STAGES.has(task.stage)
  if (!parts.delegated && taskOwnAsks(task)) asks = true
  let childCount = 0
  let childrenDone = true
  for (const word of parts.sessions ?? []) {
    started = true
    if (word === 'error') error = true
    else if (word === 'needs-you') asks = true
    else if (word === 'working') working = true
    else if (word === 'idle') idle = true
  }
  for (const word of parts.children ?? []) {
    childCount += 1
    if (word !== 'done') childrenDone = false
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
  // A phase only groups (D1, POD-2178): Done once every sub-issue is, unless
  // something on it still errs, asks or works (an idle lead does not count).
  if (task.type === 'phase' && childCount > 0 && childrenDone) return 'done'
  if (idle) return 'idle'
  if (blocked) return 'blocked'
  return started ? 'idle' : 'not-started'
}

/** One session as a task's word reads it (POD-2171). */
export interface SeatWords {
  /** Its word on an uncoordinated task: what its own line shows. */
  readonly word: SessionWord
  /** Its word as the coordinator of a coordinated task: every ask counts. */
  readonly coordinator: SessionWord
  /** Its word as a delegate: only an exception asks. */
  readonly delegate: SessionWord
  /** It holds the task's coordinator seat. */
  readonly lead?: boolean
}

/**
 * The word of a seat on a coordinated task: its {@link coordinatedSeat} verdict
 * in D5's words, with the same precedence as {@link sessionWord}. Only a
 * translation; the verdict decides.
 */
export function coordinatedWord(seat: CoordinatedSeat): SessionWord {
  if (!seat.counted) return 'done'
  if (seat.error) return 'error'
  if (seat.asks) return 'needs-you'
  if (seat.working) return 'working'
  return seat.stopped ? 'done' : 'idle'
}

/**
 * A session's {@link SeatWords}. The role words are {@link coordinatedWord} of
 * its {@link coordinatedSeat} verdicts and read `roleInteractions`, its open
 * pending interactions (a seat fact on every coordinated surface); the plain
 * word reads `context` as given, so a reader that never counted them on an
 * uncoordinated task need not start.
 */
export function seatWords(
  session: SessionWordFacts,
  context: SessionWordContext = {},
  lead = false,
  roleInteractions = context.pendingInteractions,
): SeatWords {
  const interactions = { count: roleInteractions ?? 0 }
  const role = (name: 'coordinator' | 'delegate') =>
    coordinatedWord(coordinatedSeat(session, name, interactions, context.issueClosed !== true))
  return {
    word: sessionWord(session, context),
    coordinator: role('coordinator'),
    delegate: role('delegate'),
    lead,
  }
}

/** A task's two words (POD-2171, `seat-attention.ts`). */
export interface TaskWords {
  /** The word on the task's own row. */
  readonly word: TaskWord
  /** The word it shows an ancestor whose coordinator is live: only work and exceptions. */
  readonly delegated: TaskWord
}

/**
 * A task's word and its delegated word. On a task whose coordinator is live
 * (`coordinated`), its sessions other than the coordinator speak as delegates
 * and its sub-tasks show their delegated words, so asks come only from the
 * coordinator and the task's own requests, while work and errors still roll
 * up.
 *
 * The delegated word is what the task is to a coordinated ancestor: every
 * session a delegate, every sub-task's delegated word, and none of its own
 * requests (a decision type, needs-human). Those stay on its own
 * row; the ancestor's coordinator is the one they are for.
 */
export function taskWords(
  task: TaskWordFacts,
  parts: {
    readonly seats?: Iterable<SeatWords>
    readonly children?: Iterable<TaskWords>
    readonly coordinated?: boolean
  } = {},
): TaskWords {
  const seats = [...(parts.seats ?? [])]
  const children = [...(parts.children ?? [])]
  const coordinated = parts.coordinated === true
  return {
    word: taskWord(task, {
      sessions: seats.map((seat) =>
        coordinated ? (seat.lead ? seat.coordinator : seat.delegate) : seat.word,
      ),
      children: children.map((child) => (coordinated ? child.delegated : child.word)),
    }),
    delegated: taskWord(task, {
      sessions: seats.map((seat) => seat.delegate),
      children: children.map((child) => child.delegated),
      delegated: true,
    }),
  }
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
  readonly sessions: (id: Id) => Iterable<SeatWords>
  /** The task's coordinator is live (POD-2171, {@link taskWords}). */
  readonly coordinated?: (id: Id) => boolean
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
  const words = new Map<Id, TaskWords>()
  const visiting = new Set<Id>()
  const NOT_STARTED: TaskWords = { word: 'not-started', delegated: 'not-started' }
  const visit = (id: Id): TaskWords => {
    const known = words.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return NOT_STARTED
    const task = tree.task(id)
    if (!task) return NOT_STARTED
    visiting.add(id)
    const children: TaskWords[] = []
    for (const child of tree.children(id)) if (tree.task(child)) children.push(visit(child))
    const both = taskWords(task, {
      seats: tree.sessions(id),
      children,
      coordinated: tree.coordinated?.(id) === true,
    })
    visiting.delete(id)
    words.set(id, both)
    return both
  }
  visit(root)
  return new Map([...words].map(([id, both]) => [id, both.word]))
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
