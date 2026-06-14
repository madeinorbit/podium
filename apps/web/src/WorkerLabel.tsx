import type { SessionMeta } from '@podium/protocol'
import type { JSX } from 'react'
import { panelLabel } from './derive'

/**
 * Strip a leading status/spinner glyph from a live terminal title. Claude Code
 * (and others) prefix the title with an animated marker — ✻ ✽ ✶ ● · … — that
 * churns every frame and just adds visual noise in the tab bar and sidebar. Only
 * leading "symbol" glyphs (and the bullet/middle-dot) are removed, so real titles
 * like `~/src/podium` or `[branch]` keep their leading punctuation.
 */
export function normalizeTitle(title: string): string {
  return title.replace(/^[\p{So}\p{Sk}·•\s]+/u, '').trim()
}

/** The display name for a session anywhere in the UI: user-set name beats the live title. */
export function sessionDisplayName(session: SessionMeta): string {
  return session.name?.trim() || normalizeTitle(session.title) || 'untitled'
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
