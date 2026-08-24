import { panelLabel } from '@podium/client-core/viewmodels'
import type {
  AgentKind,
  HandoffBlocker,
  HandoffRejection,
  SessionMeta,
} from '@podium/model/browser'

/**
 * The session-menu VOCABULARY — eligibility rules and blocker/rejection copy —
 * apart from the menu itself. Rows, palettes and lifecycle actions consult
 * these on every render; the menu component in SessionContextMenu.tsx only
 * exists after a right-click, so it loads lazily and must not be the price of
 * asking "which items would apply?".
 */

export interface ContextMenuAnchor {
  x: number
  y: number
}

/**
 * Which lifecycle actions apply to a session right now. Pure so the eligibility
 * rules (which gate the menu items) can be unit-tested without rendering.
 *
 * THE VERBS ARE NAMED BY WHAT SURVIVES (POD-1077). Three of them park or kill a
 * process and they used to be spelled Hibernate / Archive / Close, which said
 * nothing about which one you could come back from:
 *  - hibernate: only a live, recoverable agent that isn't mid-turn (parking a
 *    working agent would lose its in-flight turn — the server enforces this too).
 *    Keeps the worktree.
 *  - end: a running session, cleanly stopped [spec:SP-9904] — frees the worktree,
 *    keeps branch + transcript + row. Deliberately NOT gated on `resumable`: the
 *    row survives either way, and the server refuses what it cannot do.
 *  - resume: a parked session (hibernated, or exited-but-recoverable).
 *  - delete: tombstones the row. Offered whatever the status, because a stopped
 *    session is exactly the one you want to be able to clear away — the old
 *    `canClose` gate hid the action on the sessions it suited best.
 */
export function sessionMenuEligibility(session: SessionMeta): {
  canHibernate: boolean
  canResume: boolean
  canEnd: boolean
  canDelete: boolean
  canMarkRead: boolean
  canMarkUnread: boolean
} {
  const phase = session.agentState?.phase
  const working = phase === 'working' || phase === 'compacting'
  const status = session.status
  const running = status === 'live' || status === 'starting' || status === 'reconnecting'
  return {
    canHibernate: status === 'live' && session.resumable === true && !working,
    canResume: status === 'hibernated' || (status === 'exited' && session.resumable === true),
    canEnd: running,
    canDelete: true,
    // Email-style read toggle (#138): a currently-read session offers "mark unread";
    // an unread one offers "mark read". (`unread` is always a boolean on the wire.)
    canMarkRead: session.unread === true,
    canMarkUnread: !session.unread,
  }
}

/**
 * Why this session can't be handed off at all (POD-821). The Handoff item is
 * always offered and states its case rather than disappearing: a hidden item is
 * indistinguishable from a broken eligibility gate, which is how a stale repo
 * list went unnoticed after a successful handoff.
 */
export function handoffBlockerText(blocker: HandoffBlocker, agentKind: AgentKind): string {
  switch (blocker) {
    case 'harness':
      return `${panelLabel(agentKind)} sessions can't be handed off`
    case 'no-worktree':
      return 'Only sessions in a worktree can be handed off'
    case 'repo-unregistered':
      return "This repo isn't registered on another machine"
    default: {
      const exhaustive: never = blocker
      return exhaustive
    }
  }
}

/** Why an ISSUE row offers no handoff subject (POD-850) — no session to name. */
export function issueHandoffBlockerText(blocker: 'no-agent-session' | 'multiple-sessions'): string {
  return blocker === 'no-agent-session'
    ? 'No agent session to hand off'
    : 'Multiple sessions — use a session’s menu'
}

/** Why one machine can't take this session — shown beside its (disabled) row. */
export function handoffRejectionText(rejection: HandoffRejection, agentKind: AgentKind): string {
  switch (rejection) {
    // Distinct from 'offline' on purpose (readiness §3.1.4 M5): handing off to a
    // machine you may not use is DENIED, not merely unavailable, and a user who
    // reads "offline" waits for a wake-up that will never help.
    case 'unauthorized':
      return 'no access'
    // POD-2700, and for the same reason as 'unauthorized' above: a machine with
    // no Podium daemon can never import a worktree, so calling it offline offers
    // a wake-up that will never help.
    case 'no-daemon':
      return 'no daemon'
    case 'offline':
      return 'offline'
    case 'harness-missing':
      return `no ${panelLabel(agentKind)}`
    case 'repo-missing':
      return 'no clone URL for repo'
    default: {
      const exhaustive: never = rejection
      return exhaustive
    }
  }
}
