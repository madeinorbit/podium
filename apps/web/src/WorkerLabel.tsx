import type { AgentKind, SessionMeta } from '@podium/protocol'
import { Bot, Code2, type LucideIcon, SquareChevronRight, Zap } from 'lucide-react'
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

/** Worker-kind → glyph. A small icon reads faster than a CLAUDE/SHELL word and
 *  leaves more room for the name; the kind's name rides on the hover title. */
const KIND_ICON: Record<AgentKind, LucideIcon> = {
  'claude-code': Bot,
  codex: Code2,
  grok: Zap,
  shell: SquareChevronRight,
}

/** The agent-kind icon — shown right after the status dot, with the kind's name
 *  ("Claude", "Shell", …) on the hover title in place of the old text badge. */
export function KindIcon({ kind }: { kind: AgentKind }): JSX.Element {
  const Icon = KIND_ICON[kind]
  return (
    <span className="flex-none text-muted-foreground/70" title={panelLabel(kind)}>
      <Icon size={13} aria-label={panelLabel(kind)} />
    </span>
  )
}

/**
 * A worker panel's label: a small kind icon (Claude / Codex / Grok / shell) then
 * the user-set name when present, else the live name the agent gave itself
 * (Claude `/rename`, a Codex thread, a tmux window, a shell prompt — captured from
 * the terminal title). The full name rides on the hover title so a truncated row
 * is still readable.
 */
export function WorkerLabel({ session }: { session: SessionMeta }): JSX.Element {
  const name = sessionDisplayName(session)
  return (
    <span className="worker-label inline-flex min-w-0 items-center gap-1.5">
      <KindIcon kind={session.agentKind} />
      <span className="worker-name overflow-hidden text-ellipsis whitespace-nowrap" title={name}>
        {name}
      </span>
    </span>
  )
}
