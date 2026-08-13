/**
 * Pure command-palette model (no React): the command shape, the cmdk-inspired
 * subsequence scorer, and the grouped filter the palette renders from. Kept
 * separate from CommandPalette.tsx so ranking/grouping is unit-testable.
 *
 * THE GROUPING IS THE FEATURE (POD-745).
 *
 * The first version had three groups — navigate / global / session — and one
 * cap of 8 on `navigate`. Everything that was not a global or session action
 * went into `navigate`: sessions, worktrees, tasks, AND the ~40 rows the issue
 * context menu projects for the selected task ("POD-745: Set colour: Amber").
 * Two failures followed from that single bucket, and neither was a styling
 * problem:
 *
 *   · AT REST the palette showed eight sessions and nothing else. Every score
 *     ties at 1 when the query is empty, so the cap was decided by push order,
 *     and sessions were pushed first. The one moment the palette has to say
 *     what it is for, it listed eight arbitrary agents.
 *   · UNDER A QUERY one task's forty menu permutations could take the whole
 *     cap and push every other task out of the results.
 *
 * So the model now has SEVEN groups, each with its own cap, and the caps differ
 * between the resting and the queried state because those are two different
 * screens. At rest the palette is a HOME: recents, what you can do to the task
 * and the agent you are looking at, and the command list. The raw indexes —
 * every task, every agent, every worktree — are answers to a query and are not
 * offered before there is one (`rest: 0`).
 */

import type { SessionMeta } from '@podium/model/browser'
import type { IssueReferenceModel } from '@podium/client-core/viewmodels'
import type { ComponentType } from 'react'

export type PaletteGroupId =
  /** Curated home row: what you touched last. Resting state only. */
  | 'recent'
  /** The task index — issues from the replica plus server search hits. */
  | 'task'
  /** The agent index — live and hibernated sessions. */
  | 'agent'
  /** The place index — worktrees. */
  | 'place'
  /** Actions on the task the shell is pointed at. */
  | 'on-task'
  /** Actions on the focused agent. */
  | 'on-agent'
  /** Window-scoped commands: create, go to, open a panel. */
  | 'action'

/** Leading glyph. A component so a command can carry a harness brand mark or a
 *  menu icon without this module owning an icon registry. */
export type PaletteIcon = ComponentType<{ size?: number; className?: string }>

export interface PaletteCommand {
  id: string
  group: PaletteGroupId
  label: string
  /** Extra match terms (repo name, agent kind, aliases…) — weighted below label. */
  keywords?: string[]
  /** Right-aligned annotation (e.g. stage, worktree). Display-only, never matched. */
  hint?: string
  /** Rich identity for task rows; filtering still uses label/keywords. */
  issueReference?: IssueReferenceModel
  /** Rich identity for agent rows — carries the live working/waiting glyph. */
  session?: SessionMeta
  /** Leading glyph for rows that have no richer identity. */
  icon?: PaletteIcon
  run: () => void | Promise<void>
}

export interface PaletteGroup {
  group: PaletteGroupId
  commands: PaletteCommand[]
  /** Matches before the cap — the group label states `shown/total` when capped. */
  total: number
  /** The group's strongest match; orders the groups under a query. */
  top: number
}

/** Declared order. Also the tiebreak when two groups match a query equally well. */
const GROUP_ORDER: PaletteGroupId[] = [
  'recent',
  'task',
  'agent',
  'place',
  'on-task',
  'on-agent',
  'action',
]

/**
 * How many rows a group may contribute, per state.
 *
 * `rest: 0` means the group does not exist until you type — that is the whole
 * correction. The three indexes are unbounded lists whose resting order carries
 * no information, and `recent` says the useful part of all three in six rows.
 * `query: 0` on `recent` is the mirror: once there is a query, the real groups
 * answer it and a second copy of the same rows under a "RECENT" label would be
 * duplicate results.
 */
export const GROUP_CAP: Record<PaletteGroupId, { rest: number; query: number }> = {
  recent: { rest: 6, query: 0 },
  task: { rest: 0, query: 6 },
  agent: { rest: 0, query: 5 },
  place: { rest: 0, query: 4 },
  'on-task': { rest: 5, query: 12 },
  'on-agent': { rest: 6, query: Number.POSITIVE_INFINITY },
  action: { rest: 10, query: Number.POSITIVE_INFINITY },
}

/**
 * Subsequence score of `query` against one text. 0 = not a subsequence.
 * cmdk-style shaping: every matched char counts, consecutive matches earn a
 * continuous-run bonus, and a match that starts a word (or the string) earns a
 * boundary bonus — so "wt" prefers "Web Terminal" over "sweatshirt".
 *
 * A LITERAL RUN OUTRANKS A SCATTERED ONE. The per-character bonuses alone let a
 * subsequence spread across several word starts out-earn an exact hit: "close"
 * scored HIGHER against "clone the seat" (four boundary bonuses) than against
 * "Close session", so the palette answered a typed word with a task that does
 * not contain it. Containing the query whole is worth more than any arrangement
 * of the letters, and starting with it is worth more again.
 */
function scoreText(query: string, text: string): number {
  const t = text.toLowerCase()
  const at = t.indexOf(query)
  let score = 0
  if (at === 0) score += 12
  else if (at > 0) score += /[\s\-_/:.]/.test(t[at - 1] as string) ? 8 : 4
  let prev = -2
  let from = 0
  for (const ch of query) {
    const idx = t.indexOf(ch, from)
    if (idx === -1) return 0
    score += 1
    if (idx === prev + 1) score += 1 // continuous run
    if (idx === 0 || /[\s\-_/:.]/.test(t[idx - 1] as string)) score += 2 // word-boundary start
    prev = idx
    from = idx + 1
  }
  return score
}

/**
 * Score a command against a query. Label matches are weighted over keyword
 * matches (a keyword hit should never outrank the same-quality label hit).
 * Empty query matches everything at a flat score.
 */
export function scoreCommand(query: string, cmd: PaletteCommand): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const label = scoreText(q, cmd.label) * 2
  let kw = 0
  for (const k of cmd.keywords ?? []) kw = Math.max(kw, scoreText(q, k))
  return Math.max(label, kw)
}

/** True when the palette is showing its home rather than answering a query. */
export function isResting(query: string): boolean {
  return query.trim().length === 0
}

/**
 * Filter + rank commands for rendering: score, sort per group (stable — the
 * caller's order breaks ties), drop empty and out-of-state groups, cap each
 * group on its own budget.
 *
 * Group ORDER is declared at rest and EARNED under a query: a query sorts the
 * groups by their strongest member, so typing "close" puts the group that owns
 * "Close session" above four groups of tasks that merely contain the letters.
 * A fixed order is right for a home screen and wrong for a search result.
 */
export function filterCommands(query: string, commands: PaletteCommand[]): PaletteGroup[] {
  const resting = isResting(query)
  const scored = commands
    .map((cmd, order) => ({ cmd, order, score: scoreCommand(query, cmd) }))
    .filter((s) => s.score > 0)
  const groups: PaletteGroup[] = []
  for (const group of GROUP_ORDER) {
    const cap = resting ? GROUP_CAP[group].rest : GROUP_CAP[group].query
    if (cap <= 0) continue
    const mine = scored
      .filter((s) => s.cmd.group === group)
      .sort((a, b) => b.score - a.score || a.order - b.order)
    const best = mine[0]
    if (!best) continue
    groups.push({
      group,
      commands: mine.slice(0, cap).map((s) => s.cmd),
      total: mine.length,
      top: best.score,
    })
  }
  if (!resting) {
    groups.sort(
      (a, b) => b.top - a.top || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    )
  }
  return groups
}

/** Flat row list in render order — drives the roving highlight index. */
export function flattenGroups(groups: PaletteGroup[]): PaletteCommand[] {
  return groups.flatMap((g) => g.commands)
}

/**
 * Move the roving highlight by `delta`, wrapping across the ends (cmdk-style).
 * `count` includes the free-text fallback rows, so it is only 0 when the
 * palette has genuinely nothing to offer.
 */
export function moveHighlight(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

/**
 * Default highlight after the rows change: the top result — which IS the
 * fallback row when nothing matched (the fallback is appended after `matchCount`
 * real rows, so with zero matches index 0 lands on it and plain Enter spawns).
 */
export function defaultHighlight(_matchCount: number): number {
  return 0
}
