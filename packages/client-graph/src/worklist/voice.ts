import type { IssueNavigationModel } from '@podium/client-core/values'
import {
  ISSUE_STATUS_LABELS,
  issueLanding,
  issueStatusLabel,
  issueStatusOf,
} from '@podium/model/browser'
import type { SidebarRowValues, SidebarTiming } from './sidebar-row'

export type RowTone =
  /** Needs review, waiting on you, ready to merge: bisque dot, bronze word. */
  | 'needs'
  /** An agent is computing: the shared working mark. */
  | 'working'
  /** Started but nobody is computing: hollow blue ring. */
  | 'active'
  /** Planned or queued: hollow grey ring. */
  | 'idle'
  /** Every subtask done, awaiting the parent: soft filled dot. */
  | 'settled'
  /** Finished: a check, muted row. */
  | 'done'
  /** Stopped without finishing: a minus, muted row. */
  | 'closed'
  /** A draft that has not started. */
  | 'draft'
  /** An agent stopped on an error. */
  | 'error'

/** What line 2 says, in the calm design's vocabulary (POD-2074): one tone, one
 * word, and an optional sub-fact. The old status sentence stays the filter's
 * haystack, so typing "needs review" or "2 working" still finds a row. */
export interface RowVoice {
  tone: RowTone
  word: string
  /** The trailing fact after the word: `· 7/7`, or `3/3` on a settled row. */
  sub: string | null
}

export interface RowVoiceInput {
  decision: 'merge' | 'review' | null
  phase: SidebarTiming['phase']
  working: boolean
  awaitingFirstPrompt?: boolean
  showsChildProgress: boolean
  progress: { done: number; total: number } | null
  issue: SidebarRowValues['issue'] | IssueNavigationModel
  continuation?: { kind: string; ref: string } | null
}

export function rowVoice(input: RowVoiceInput): RowVoice {
  const total = input.progress?.total ?? 0
  const done = input.progress?.done ?? 0
  // A lone subtask's `0/1` says nothing the word does not; two or more tally.
  const fraction = total > 1 ? `${done}/${total}` : null
  const sub = fraction ? `· ${fraction}` : null
  const issue = input.issue as unknown as IssueNavigationModel
  const status = issueStatusOf(issue)
  // A closed handoff points FORWARD — where the work continued — and asks
  // nothing here (POD-1193 withdraws its decision).
  if (input.continuation)
    return {
      tone: status === 'done' ? 'done' : 'idle',
      word: `${capitalize(input.continuation.kind)} · ${input.continuation.ref}`,
      sub: null,
    }
  // A finished branch awaiting merge still needs you.
  if (input.decision === 'merge')
    return {
      tone: 'needs',
      word: 'Ready to merge',
      sub,
    }
  if (input.decision === 'review') return { tone: 'needs', word: 'Needs review', sub }
  if (status === 'done') {
    // A merge-action landing names where it went and what (POD-2151).
    const landing = issueLanding(issue)
    if (!landing) return { tone: 'done', word: 'Done', sub: null }
    const facts = [landing.branch, landing.sha].filter(Boolean)
    return { tone: 'done', word: 'Landed', sub: facts.length > 0 ? `· ${facts.join(' · ')}` : null }
  }
  if (status === 'cancelled' || status === 'duplicate' || status === 'superseded')
    return { tone: 'closed', word: ISSUE_STATUS_LABELS[status], sub: null }
  if (input.phase === 'waiting') return { tone: 'needs', word: 'Waiting on you', sub }
  if (input.working) return { tone: 'working', word: 'Working', sub }
  if (input.awaitingFirstPrompt) return { tone: 'draft', word: 'Draft', sub: null }
  if (input.showsChildProgress && total > 0 && done === total)
    return { tone: 'settled', word: 'Subtasks done', sub: fraction }
  if ((issue as { blocked?: boolean }).blocked) return { tone: 'idle', word: 'Blocked', sub }
  if (status === 'in_progress' || status === 'review' || status === 'shipping')
    return {
      tone: 'active',
      word: status === 'review' ? 'In review' : capitalize(issueStatusLabel(issue).toLowerCase()),
      sub,
    }
  return { tone: 'idle', word: capitalize(issueStatusLabel(issue).toLowerCase()), sub }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
