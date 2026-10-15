import type { IssueId, SessionId } from '../ids/brands'
import type { SessionWord, TaskWord, TaskWordTally } from '../predicates/state-word'
import type { IssueTreeSession } from './session-read'

/** One-shot deck report for readers without a replica. Never stored or fed. */
export interface IssueDeckSession extends IssueTreeSession {
  seat: 'coordinator' | 'phase-lead' | 'worker' | 'helper'
  word: SessionWord
}

export interface IssueDeckBlocker {
  id: IssueId
  displayRef: string
  title: string
  /** Dependencies outside the deck still block, but draw no internal edge. */
  external: boolean
}

export interface IssueDeckNode {
  id: IssueId
  displayRef: string
  title: string
  type: string
  stage: string
  word: TaskWord
  /** Cancelled, duplicate and superseded closes count as done but are hidden. */
  hidden: boolean
  counter: { done: number; total: number }
  sessions: IssueDeckSession[]
  blockers: IssueDeckBlocker[]
  children: IssueDeckNode[]
}

export interface IssueDeckProposal extends IssueDeckNode {
  proposedBy: { sessionId: SessionId; displayRef?: string } | null
  placement: 'here' | 'own-issue'
}

export interface IssueDeck {
  root: IssueDeckNode
  /** Leaf task units, never phase containers. Includes hidden done closes. */
  counts: TaskWordTally
  proposals: IssueDeckProposal[]
}
