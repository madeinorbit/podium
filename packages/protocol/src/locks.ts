/**
 * Advisory lock read models shared by the server, CLI, and human clients.
 *
 * These are query-response types rather than replicated entities: `lock.status`
 * is authoritative because reading it also performs the lock service's lazy
 * lease-expiry sweep. Consumers must preserve `queue` order; `position` is the
 * server-assigned, one-based FIFO position and is not a client sort key.
 */

import type { IssueId, SessionId } from '@podium/model'

/**
 * A real agent session or one of the lock service's documented non-session
 * principals. A granted operator lease is represented as `null`; the
 * `operator` sentinel can appear while that principal is queued.
 */
export type LockSessionIdWire = SessionId | 'operator' | 'unknown-session'

export interface LockHolderWire {
  sessionId: LockSessionIdWire | null
  issueId: IssueId | null
  label: string
  /**
   * Whether the holder's session is still live. Operator (null session) is
   * always true; unknown-relay is always false. Waiters that would be pruned
   * on the next queue advance report false here so status is not misleading.
   */
  alive: boolean
  /**
   * Live session cwd/worktree root when the session is known and alive; null
   * for operator, dead sessions, and unknown-relay. Shared-worktree collision
   * detection keys on this (issue labels alone lie when many issues share a
   * checkout).
   */
  workspace: string | null
}

export interface LockQueueEntryWire extends Omit<LockHolderWire, 'sessionId'> {
  /** Real session identity, or the queued operator/unknown-relay sentinel. */
  sessionId: LockSessionIdWire
  /** One-based FIFO grant position. */
  position: number
  enqueuedAt: string
}

export interface LockWire {
  repoId: string
  name: string
  holder: LockHolderWire
  note: string | null
  acquiredAt: string
  expiresAt: string
  /** Whole seconds remaining when the authority produced this response. */
  secondsLeft: number
  /** Already in FIFO grant order. */
  queue: LockQueueEntryWire[]
}

export type LockAcquireResultWire =
  | { granted: true; alreadyHeld: boolean; lock: LockWire }
  | { granted: false; position: number; lock: LockWire }
