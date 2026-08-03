/**
 * THE PANEL'S LIFECYCLE ACTIONS, AS DATA (POD-408).
 *
 * Waking a session was written FOUR times in `AgentPanel.tsx` — `ExitedPane`,
 * `ExitedBanner`, `HibernatedBanner`, `HibernatedPane` — each with its own
 * `useState(false)`, its own `.then(() => setWaking(false), () => setWaking(false))`,
 * and its own hand-spelled label ladder (`waking ? action === 'restart' ? 'Restarting…'
 * : 'Resuming…' : …`). Four copies of one rule is four places for it to drift, and
 * it had: the two panes say "Resume session" where the two banners say "Resume",
 * which is deliberate, and the hibernated pair says "Waking…" where the exited
 * pair says "Resuming…", which is not obviously either.
 *
 * This file is that rule once, as descriptors. Everything here is pure: no JSX,
 * no store, no React. `SessionLifecyclePanes` renders them and
 * `useLifecycleRunner` owns the one busy flag.
 *
 * WHY NOT A SLICE. `sessionMenuEligibility` (`@/lib/SessionContextMenu`) already
 * publishes the eligibility rules and already has two consumers (the session
 * context menu and the command palette). This module does not restate them — it
 * IMPORTS them, which is how the panel stopped being a third, disagreeing copy:
 * its own `canHibernate` read `!hibernated && !exited && resumable`, so it offered
 * Hibernate on a `starting` or `reconnecting` session, where the shared rule (and
 * the server) says no.
 */
import type { SessionMeta } from '@podium/model'
import { sessionMenuEligibility } from '@/lib/SessionContextMenu'

/** What the action does, not what it is called — the label is presentation. */
export type LifecycleActionId = 'resume' | 'restart' | 'remove' | 'hibernate'

/** Which store action runs it. Kept as a tag rather than a bound closure so the
 *  descriptors stay pure and testable without a store. */
export type LifecycleRun = 'resurrect' | 'kill' | 'hibernate'

export interface LifecycleAction {
  readonly id: LifecycleActionId
  readonly run: LifecycleRun
  /** Full-pane label — the pane is the only thing on screen, so it says what it
   *  acts on. */
  readonly label: string
  /** Banner label — the banner sits over the transcript, where the subject is
   *  already on screen and the row is tight. */
  readonly compactLabel: string
  /** Shown while the action is in flight, or `null` for an action that keeps no
   *  busy state (Remove: the row disappears, so there is nothing to re-label). */
  readonly busyLabel: string | null
  /** The pane's second sentence — why this is the way back. */
  readonly hint: string
  /** Offered but not takeable right now, with the reason on the control. */
  readonly disabledReason: string | null
}

/**
 * The way back from a read-only state.
 *
 * `parked` (hibernated) has exactly one: wake it. `ended` (exited) takes the
 * verb `exitedRecovery` already decided — restart a shell, resume an agent that
 * left a ref, remove what neither applies to.
 */
export function recoveryAction(
  kind: 'parked' | 'ended',
  action: 'restart' | 'resume' | 'remove',
  worktreeMissing = false,
): LifecycleAction {
  if (kind === 'parked') {
    return {
      id: 'resume',
      run: 'resurrect',
      label: 'Resume session',
      compactLabel: 'Resume',
      busyLabel: 'Waking…',
      hint: 'This session is hibernated — its process was stopped to free memory, but the conversation is intact.',
      disabledReason: null,
    }
  }
  if (action === 'restart') {
    return {
      id: 'restart',
      run: 'resurrect',
      label: 'Restart shell',
      compactLabel: 'Restart',
      busyLabel: 'Restarting…',
      hint: 'Restart opens a fresh shell in the same directory.',
      disabledReason: null,
    }
  }
  if (action === 'resume') {
    return {
      id: 'resume',
      run: 'resurrect',
      label: 'Resume session',
      compactLabel: 'Resume',
      busyLabel: 'Resuming…',
      hint: 'The conversation is intact — resume to pick up where it left off.',
      disabledReason: null,
    }
  }
  return {
    id: 'remove',
    run: 'kill',
    label: 'Remove session',
    compactLabel: 'Remove',
    busyLabel: null,
    hint: worktreeMissing ? 'Remove it to clear it away.' : 'It left no conversation to resume.',
    disabledReason: null,
  }
}

/**
 * Manual hibernation, or `null` when it does not apply to this session at all.
 *
 * The panel OFFERS it while the agent is mid-turn and says why, where the
 * context menu simply hides it — a menu that is a list of what you can do now,
 * against a panel that is the session's own home and owes an explanation. Both
 * read the same eligibility: `sessionMenuEligibility.canHibernate` already folds
 * the mid-turn rule in, so "applies at all" is that predicate OR'd with the one
 * state it excludes.
 */
export function hibernateAction(session: SessionMeta | undefined): LifecycleAction | null {
  if (!session) return null
  const { canHibernate } = sessionMenuEligibility(session)
  const phase = session.agentState?.phase
  const working = phase === 'working' || phase === 'compacting'
  const blockedByTurn = working && session.status === 'live' && session.resumable === true
  if (!canHibernate && !blockedByTurn) return null
  return {
    id: 'hibernate',
    run: 'hibernate',
    label: 'Hibernate',
    compactLabel: 'Hibernate',
    busyLabel: null,
    hint: '',
    disabledReason: blockedByTurn ? 'Agent is working — hibernate once it reaches idle' : null,
  }
}
