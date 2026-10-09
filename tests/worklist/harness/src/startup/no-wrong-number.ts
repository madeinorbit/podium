/**
 * POD-5594 — the "no wrong number" check for startup (POD-5592, First screen
 * before history).
 *
 * Startup may paint before history has arrived. That is only honest if every
 * question the app asks is either RIGHT or says it is still on its way: a
 * count, a search, the board's closed tabs and a parent's closed-children
 * progress must never show a smaller number because history is missing
 * (docs/agents/frontend-data.md rule 7: here, on its way, or gone).
 *
 * The check asks one fixed list of questions (`startupQuestions`) of two
 * pools: a CONTROL that holds the full bootstrap, and a CANDIDATE in any
 * intermediate startup state (active rows only, history arriving in batches,
 * markers or none). Every candidate answer must equal the control's or be
 * `LOADING`. Anything else is a wrong number (`checkNoWrongNumber`).
 *
 * The pools are plain `MobxPool`s, so POD-5595 (markers), POD-5597 (paint
 * after active rows) and POD-5599 (screens wait honestly) can feed it their
 * own states: build the candidate however that issue builds it, then
 * `checkNoWrongNumber(ask(control, qs), ask(candidate, qs))`.
 */
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { BOARD_EXPLORER_TABS } from '@podium/client-graph/issue-board-schema'
import { chatMentionMatches } from '@podium/client-graph/chat-context'
import { missionView } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { autorun } from 'mobx'
import { isDeepStrictEqual } from 'node:util'

/** The question groups the brief names, plus the first screen itself. */
export type StartupGroup = 'first-screen' | 'counts' | 'search' | 'board-archive' | 'closed-children'

export interface StartupQuestion {
  readonly name: string
  readonly group: StartupGroup
  /** The answer as the app reads it: `LOADING`, or a plain comparable value. */
  read(pool: MobxPool): unknown
}

/** What the questions are asked about, picked once from the CONTROL's rows. */
export interface StartupTargets {
  /** Open top-level issues: rows the first screen draws. */
  readonly roots: readonly string[]
  /** Parents with at least one closed child (closed-children progress). */
  readonly parents: readonly string[]
  /** Search needles: common title words, and words only closed work carries. */
  readonly needles: readonly string[]
}

type IssueRow = { id: string; title?: string; parentId?: string | null; closedAt?: string | null; archived?: boolean; deletedAt?: string | null }

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Deterministic targets from the full row set (the control's). */
export function startupTargets(
  rows: readonly RowRecord[],
  sizes: { roots?: number; parents?: number; needles?: number } = {},
): StartupTargets {
  const issues = rows.filter((row) => row.kind === 'issue' && row.value !== undefined).map((row) => row.value as IssueRow)
  const closed = (issue: IssueRow) => issue.closedAt != null || issue.archived === true || issue.deletedAt != null
  const roots = issues
    .filter((issue) => issue.parentId == null && !closed(issue))
    .map((issue) => issue.id)
    .sort(byId)
    .slice(0, sizes.roots ?? 24)
  const closedChildren = new Map<string, number>()
  for (const issue of issues)
    if (issue.parentId != null && closed(issue))
      closedChildren.set(issue.parentId, (closedChildren.get(issue.parentId) ?? 0) + 1)
  // The parents with the most closed children (history-heavy progress), then
  // the first ones by id (ordinary progress), so both kinds are asked.
  const ranked = [...closedChildren].sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).map(([id]) => id)
  const half = Math.ceil((sizes.parents ?? 24) / 2)
  const parents = [...new Set([...ranked.slice(0, half), ...[...closedChildren.keys()].sort(byId).slice(0, half)])]
  const words = (issue: IssueRow) =>
    new Set((issue.title ?? '').toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 5))
  const frequency = new Map<string, number>(),
    openWords = new Set<string>()
  for (const issue of issues)
    for (const word of words(issue)) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1)
      if (!closed(issue)) openWords.add(word)
    }
  const common = [...frequency].sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).map(([word]) => word)
  const count = sizes.needles ?? 8
  const needles = [
    ...common.slice(0, Math.ceil(count / 2)),
    ...common.filter((word) => !openWords.has(word)).slice(0, Math.floor(count / 2)),
  ]
  return { roots, parents, needles }
}

/** Sets and maps become sorted arrays, so answers compare structurally. */
function plain(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === LOADING) return LOADING
  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('[no-wrong-number] cyclic answer; read displayed fields instead of model ownership')
    ancestors.add(value)
    try {
      if (value instanceof Set) return [...value].map(item => plain(item, ancestors)).sort()
      if (value instanceof Map) return [...value].map(([key, item]) => [key, plain(item, ancestors)]).sort()
      if (Array.isArray(value)) return value.map(item => plain(item, ancestors))
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) {
        const item = (value as Record<string, unknown>)[key]
        if (typeof item !== 'function') out[key] = plain(item, ancestors)
      }
      return out
    } finally {
      ancestors.delete(value)
    }
  }
  return value
}

/** A list answer that admits it is incomplete is on its way. */
const pendingOr = <T>(pending: number, value: T): T | typeof LOADING => (pending > 0 ? LOADING : value)

/** The declared first-screen and history questions, over `targets`. */
export function startupQuestions(targets: StartupTargets): StartupQuestion[] {
  const questions: StartupQuestion[] = []
  const add = (group: StartupGroup, name: string, read: (pool: MobxPool) => unknown) =>
    questions.push({ group, name: `${group}:${name}`, read })
  const board = (pool: MobxPool) => createIssueBoardSource(pool)

  for (const id of targets.roots) add('first-screen', `sidebar-row:${id}`, (pool) => {
    const row = sidebarView(pool).row(id)
    if (row === LOADING || row === undefined) return row
    // A companion owns references to its model and view, not a serializable
    // answer. Ask the facts UnifiedIssueRow displays, without walking its pool.
    const progress = row.progress
    if (progress === LOADING) return LOADING
    return {
      id: row.id, title: row.title, seq: row.issue.seq, color: row.issue.color,
      stage: row.issue.stage, timing: row.timing, working: row.visibleWorking,
      asking: row.visibleAsking, origin: row.origin, decision: row.decision,
      mergeCommits: row.mergeCommits, progress, showsChildProgress: row.showsChildProgress,
      unread: row.visibleUnread, errorClass: row.errorClass, fleet: row.visibleFleet,
      sessionOnlyDraft: row.sessionOnlyDraft, firstSessionId: row.firstSessionId,
      continuation: row.continuation,
    }
  })

  add('counts', 'issues', (pool) => pool.queries.count('issue'))
  add('counts', 'sessions', (pool) => pool.queries.count('session'))
  add('counts', 'undeleted-issues', (pool) => pool.undeletedIssueCount)
  add('counts', 'board-tabs', (pool) => board(pool).explorerCounts())
  add('counts', 'proposed', (pool) => pool.queries.ids({ kind: 'proposedIssues' }).length)

  add('search', 'command-issues', (pool) => pool.queries.ids({ kind: 'commandIssues' }))
  for (const needle of targets.needles) {
    add('search', `local-text:${needle}`, (pool) => pool.queries.localTextIds(needle))
    add('search', `mention:${needle}`, (pool) => {
      const found = chatMentionMatches(pool, needle, 8)
      return pendingOr(found.pending, found.issues.map((issue) => issue.id))
    })
    add('search', `board:${needle}`, (pool) => {
      const found = board(pool).explorer({ tab: null, query: needle, windowed: true })
      return found === LOADING || found === undefined ? found : { tab: found.tab, ids: found.ids }
    })
  }

  for (const tab of BOARD_EXPLORER_TABS)
    add('board-archive', `tab:${tab}`, (pool) => {
      const found = board(pool).explorer({ tab, query: '', windowed: true })
      return found === LOADING || found === undefined ? found : { total: found.total, ids: found.ids }
    })
  add('board-archive', 'archived', (pool) => pool.queries.ids({ kind: 'boardIssues', archived: true }))

  for (const id of targets.parents) {
    add('closed-children', `child-counts:${id}`, (pool) => pool.queries.issueChildCounts(id))
    add('closed-children', `model:${id}`, (pool) => {
      const model = pool.issue(id)
      if (model === undefined) return pool.resident('issue', id) === 'loading' ? LOADING : undefined
      return { childCount: model.childCount, childDoneCount: model.childDoneCount }
    })
    add('closed-children', `mission:${id}`, (pool) => {
      const values = missionView(pool).values(id, 'full')
      return values === LOADING ? LOADING : values.progress
    })
    add('closed-children', `board-card:${id}`, (pool) => {
      const card = board(pool).issue(id)
      return card === LOADING || card === undefined ? card : { progress: (card as { progress?: unknown }).progress }
    })
  }
  return questions
}

/** One answer per question, read inside a tracking context as a screen reads. */
export function ask(pool: MobxPool, questions: readonly StartupQuestion[]): Map<string, unknown> {
  const answers = new Map<string, unknown>()
  let failed = false, failure: unknown
  const stop = autorun(() => {
    answers.clear()
    for (const question of questions) {
      let answer: unknown
      try {
        answer = question.read(pool)
      } catch (error) {
        // A model getter throws LOADING for a cold dependency.
        if (error !== LOADING) throw error
        answer = LOADING
      }
      answers.set(question.name, plain(answer))
    }
  }, { onError(error) { failed = true; failure = error } })
  stop()
  if (failed) throw failure
  if (answers.size !== questions.length) throw new Error('[no-wrong-number] incomplete or duplicate question list')
  return answers
}

export interface WrongNumber {
  readonly name: string
  readonly control: unknown
  readonly candidate: unknown
}

export interface NoWrongNumberReport {
  readonly asked: number
  /** Answers equal to the control. */
  readonly equal: readonly string[]
  /** Answers on their way. */
  readonly loading: readonly string[]
  /** Answers neither equal to the control nor LOADING. Must be empty. */
  readonly wrong: readonly WrongNumber[]
}

/** Every candidate answer equals the control's or is LOADING. */
export function checkNoWrongNumber(
  control: ReadonlyMap<string, unknown>,
  candidate: ReadonlyMap<string, unknown>,
): NoWrongNumberReport {
  const equal: string[] = [],
    loading: string[] = [],
    wrong: WrongNumber[] = []
  for (const [name, expected] of control) {
    if (expected === LOADING) throw new Error(`[no-wrong-number] the control is unsettled at ${name}`)
    if (!candidate.has(name)) throw new Error(`[no-wrong-number] the candidate was not asked ${name}`)
    const actual = candidate.get(name)
    if (actual === LOADING) loading.push(name)
    else if (isDeepStrictEqual(actual, expected)) equal.push(name)
    else wrong.push({ name, control: expected, candidate: actual })
  }
  return { asked: control.size, equal, loading, wrong }
}

/** Throws, naming the first wrong answers, unless the report is clean. */
export function assertNoWrongNumber(report: NoWrongNumberReport, label = 'candidate'): void {
  if (report.wrong.length === 0) return
  const sample = report.wrong
    .slice(0, 5)
    .map((w) => `  ${w.name}: control ${JSON.stringify(w.control)?.slice(0, 160)} vs ${JSON.stringify(w.candidate)?.slice(0, 160)}`)
  throw new Error(`[no-wrong-number] ${label}: ${report.wrong.length} of ${report.asked} answers are wrong numbers\n${sample.join('\n')}`)
}

/** Per group: how many answers were equal, loading and wrong. */
export function summarize(report: NoWrongNumberReport): Record<StartupGroup, { equal: number; loading: number; wrong: number }> {
  const out = {} as Record<StartupGroup, { equal: number; loading: number; wrong: number }>
  const bump = (name: string, key: 'equal' | 'loading' | 'wrong') => {
    const group = name.slice(0, name.indexOf(':')) as StartupGroup
    out[group] ??= { equal: 0, loading: 0, wrong: 0 }
    out[group][key]++
  }
  report.equal.forEach((name) => bump(name, 'equal'))
  report.loading.forEach((name) => bump(name, 'loading'))
  report.wrong.forEach((w) => bump(w.name, 'wrong'))
  return out
}
