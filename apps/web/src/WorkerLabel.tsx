import type { SessionMeta } from '@podium/protocol'
import type { JSX } from 'react'
import { panelLabel } from './derive'

/** The display name for a session anywhere in the UI: user-set name beats the live title. */
export function sessionDisplayName(session: SessionMeta): string {
  return session.name?.trim() || session.title.trim() || 'untitled'
}

/**
 * A worker panel's label: the user-set name when present, else the live name the
 * agent gave itself (Claude `/rename`, a Codex thread, a tmux window, a shell
 * prompt — captured from the terminal title), with the worker kind as a muted tag
 * so it's still obvious whether this is Claude, Codex, or a shell.
 */
export function WorkerLabel({ session }: { session: SessionMeta }): JSX.Element {
  return (
    <span className="worker-label">
      <span className="worker-name">{sessionDisplayName(session)}</span>
      <span className="worker-kind">{panelLabel(session.agentKind)}</span>
    </span>
  )
}
