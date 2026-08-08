import { ISSUE_STAGE_LABELS } from '@podium/client-core/viewmodels'
import type { IssueStage } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'
import type { EpicProgress, IssuesDisplay } from './issues-display'

// Pure label helpers live in lib so non-issues features can use them without a
// cross-feature import (features.structure.test.ts). Re-export for issue-local
// call sites that already import from this module.
export { issueIdTitle, issueRefLabel, issueRefLong } from '@/lib/issue-labels'

export const STAGE_LABELS: Record<IssueStage, string> = { ...ISSUE_STAGE_LABELS }

export function issueCardModel(issue: IssueViewModel): {
  title: string
  typeLabel: string
  labels: string[]
  needsHuman: boolean
  seqLabel: string
  assignee?: string
  subProgress?: { done: number; total: number }
  isBlocked: boolean
  isBlocking: boolean
  sessionCount: number
  dueLabel?: string
  estimateLabel?: string
} {
  const dueLabel = issue.dueAt
    ? new Date(issue.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : undefined
  return {
    title: issue.title,
    typeLabel: issue.type,
    labels: issue.labels,
    needsHuman: issue.needsHuman,
    seqLabel: issueDisplayRef(issue),
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    ...(issue.childCount > 0
      ? { subProgress: { done: issue.childDoneCount, total: issue.childCount } }
      : {}),
    isBlocked: issue.blocked,
    isBlocking: issue.dependents.some((d) => d.type === 'blocks'),
    sessionCount: issue.sessionSummary?.total ?? 0,
    ...(dueLabel ? { dueLabel } : {}),
    ...(issue.estimateMin != null ? { estimateLabel: `${issue.estimateMin}m` } : {}),
  }
}

// ---------------------------------------------------------------------------
// THE CARD'S STATE LINE (POD-591)
//
// A board card has three slots — ref row, title, state line — and the state
// line is the one that used to be a bag. It rendered up to twelve atoms in
// source order, wrapping across two or three lines, so no two cards in a column
// were the same height and none of them could be scanned.
//
// What follows is that line as an ORDERED LIST, derived once, in RANK order:
// the operator reads left to right and stops as soon as they have their answer,
// and the row is clipped rather than wrapped, so what falls off the end is
// always the least important thing on the card. The ranking is the design
// decision; the renderer just walks the array.
//
// Rank, and why:
//   1 deleted    — the row is a tombstone; nothing else about it matters.
//   2 needs-you  — the one thing that is asking for a human. Yellow lives here.
//   3 blocked    — this task cannot move.
//   4 blocking   — this task is stopping others.
//   5 live       — agents are computing on it right now.
//   6 merge      — it has commits waiting to land.
//   7 subtree    — how far its children have got.
//   8 stages     — where those children are.
//   9..11        — the Display-menu badges (labels, due, estimate), which are
//                  preferences rather than state, and so rank below all of it.
//                  They stay honest: every toggle still changes the card.
//
// TYPE IS NOT ON THIS LINE, and that is measured rather than an oversight. Most
// tasks on a real board are bugs or features, so a type badge here gave nearly
// every card a state line — and so a fourth row of height — to say the one thing
// about it that never changes. Type is IDENTITY: it sits beside the ref in the
// card's top row (`IssueCard`), where it costs no height, and its Display toggle
// still governs it.
// ---------------------------------------------------------------------------

/** One atom of the state line, in the shape the renderer needs. */
export type CardStateSlot =
  | { kind: 'deleted' }
  | { kind: 'needs-human' }
  | { kind: 'blocked' }
  | { kind: 'blocking' }
  | { kind: 'live'; count: number }
  | { kind: 'merge'; ahead: number }
  | { kind: 'subtree'; done: number; total: number }
  | { kind: 'stages'; counts: { stage: IssueStage; count: number }[] }
  | { kind: 'labels'; labels: string[]; overflow: number }
  | { kind: 'due'; label: string }
  | { kind: 'estimate'; label: string }

/** Labels shown as colour dots before the count collapses into `+N`. */
export const CARD_LABEL_DOTS = 3

/**
 * Agents actually computing on this issue right now.
 *
 * `sessionSummary.byPhase` is keyed by `AgentPhase`, and 'working' is the only
 * one that means a machine is burning tokens for you — DESIGN.md's motion
 * grammar gates the spinner on exactly that. An issue with five attached
 * sessions and none working is still, and stillness is the signal.
 */
export function liveAgentCount(issue: IssueViewModel): number {
  return issue.sessionSummary?.byPhase?.working ?? 0
}

/**
 * Commits waiting to land, or 0.
 *
 * Read off `gitState.ahead`, which the probe leaves ABSENT on a shared checkout
 * (repo root, long-lived branch) because the merge axis is meaningless there —
 * `?? 0` is the correct reading of that absence, not a missing value.
 */
export function aheadCount(issue: IssueViewModel): number {
  return issue.gitState?.shared ? 0 : (issue.gitState?.ahead ?? 0)
}

export function issueCardStateSlots(
  issue: IssueViewModel,
  {
    badges,
    stageCounts,
    progress,
  }: {
    badges: IssuesDisplay['badges']
    stageCounts?: { stage: IssueStage; count: number }[]
    progress?: EpicProgress | null
  },
): CardStateSlot[] {
  const model = issueCardModel(issue)
  const slots: CardStateSlot[] = []
  if (issue.deletedAt) slots.push({ kind: 'deleted' })
  if (model.needsHuman) slots.push({ kind: 'needs-human' })
  if (model.isBlocked) slots.push({ kind: 'blocked' })
  if (model.isBlocking) slots.push({ kind: 'blocking' })

  // An epic reports its SUBTREE's live agents; a leaf reports its own. Both
  // answer "how much is moving under this card", which is the question — and
  // taking the larger of the two means an epic whose own sessions are working
  // never reads as quieter than one of its children.
  const live = Math.max(liveAgentCount(issue), progress?.liveAgents ?? 0)
  if (live > 0) slots.push({ kind: 'live', count: live })

  const ahead = aheadCount(issue)
  if (ahead > 0) slots.push({ kind: 'merge', ahead })

  const subtree = progress ?? (model.subProgress ? { ...model.subProgress, liveAgents: 0 } : null)
  if (subtree && subtree.total > 0) {
    slots.push({ kind: 'subtree', done: subtree.done, total: subtree.total })
  }
  if (stageCounts && stageCounts.length > 0) slots.push({ kind: 'stages', counts: stageCounts })

  if (badges.labels && model.labels.length > 0) {
    slots.push({
      kind: 'labels',
      labels: model.labels.slice(0, CARD_LABEL_DOTS),
      overflow: Math.max(0, model.labels.length - CARD_LABEL_DOTS),
    })
  }
  if (badges.due && model.dueLabel) slots.push({ kind: 'due', label: model.dueLabel })
  if (badges.estimate && model.estimateLabel) {
    slots.push({ kind: 'estimate', label: model.estimateLabel })
  }
  return slots
}

/**
 * The ONE word a dense row has space for, taken off the top of the same ranked
 * list the board card walks.
 *
 * Sub-task rows, and any other place a task appears as a line rather than a
 * card, get this — so "needs you" means the same thing and sits in the same
 * position everywhere in the workspace. Returns null for a task with nothing to
 * say, because a row that always ends in a word teaches nothing.
 */
export function issueStateWord(
  issue: IssueViewModel,
): { text: string; tone: 'attention' | 'alert' | 'live' | 'quiet' } | null {
  const [top] = issueCardStateSlots(issue, {
    badges: { labels: false, type: false, estimate: false, due: false, sessions: false },
  })
  if (!top) return null
  switch (top.kind) {
    case 'deleted':
      return { text: 'deleted', tone: 'alert' }
    case 'needs-human':
      return { text: 'needs you', tone: 'attention' }
    case 'blocked':
      return { text: 'blocked', tone: 'alert' }
    case 'blocking':
      return { text: 'blocking', tone: 'alert' }
    case 'live':
      return { text: `${top.count} working`, tone: 'live' }
    case 'merge':
      return { text: `↑${top.ahead} to land`, tone: 'attention' }
    case 'subtree':
      return { text: `${top.done}/${top.total}`, tone: 'quiet' }
    default:
      return null
  }
}

/** A short, stable age stamp for the card's top row (`12h`, `3d`, `6w`). The
 *  board is scanned, not read: `relativeTime`'s "about 12 hours ago" is four
 *  times the width for the same fact. */
export function cardAge(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.floor(d / 7)
  if (w < 53) return `${w}w`
  return `${Math.floor(d / 365)}y`
}
