import type { SessionMeta } from '@podium/protocol'
import type { JSX } from 'react'
import { panelLabel } from './derive'

/**
 * A worker panel's label: the live name it gave itself (Claude `/rename`, a Codex
 * thread, a tmux window, a shell prompt — captured from the terminal title) shown
 * prominently, with the worker kind as a muted tag so it's still obvious whether
 * this is Claude, Codex, or a shell. Falls back to "untitled" before any name.
 */
export function WorkerLabel({ session }: { session: SessionMeta }): JSX.Element {
  const name = session.title.trim()
  return (
    <span className="worker-label">
      <span className="worker-name">{name || 'untitled'}</span>
      <span className="worker-kind">{panelLabel(session.agentKind)}</span>
    </span>
  )
}
