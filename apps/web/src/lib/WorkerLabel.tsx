import type { AgentKind, SessionMeta } from '@podium/protocol'
import { SquareChevronRight } from 'lucide-react'
import type React from 'react'
import type { JSX } from 'react'
import {
  ClaudeCodeIcon,
  CursorIcon,
  GrokIcon,
  OpenAIcon,
  OpenCodeIcon,
} from '@/lib/icons/AgentIcons'
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
 * Inline rename field for a session name — drop it in place of the label while
 * editing (double-click a tab/sidebar row). Enter or blur commits, Escape
 * cancels; clicks are kept local so they don't reach the row's select handler.
 */
export function SessionNameEditor({
  value,
  onCommit,
  onCancel,
  className,
}: {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
  className?: string
}): JSX.Element {
  return (
    <input
      type="text"
      // biome-ignore lint/a11y/noAutofocus: the field exists only while actively renaming
      autoFocus
      defaultValue={value}
      className={
        className ??
        'min-w-0 flex-1 rounded-sm border border-primary/60 bg-background px-1 py-0 text-xs text-foreground outline-none'
      }
      // Select-all on open so the first keystroke replaces the whole name.
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(e.currentTarget.value)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
    />
  )
}

/** Worker-kind → glyph. A small icon reads faster than a CLAUDE/SHELL word and
 *  leaves more room for the name; the kind's name rides on the hover title. */
type IconComponent = React.ComponentType<Record<string, unknown>>

const KIND_ICON: Record<AgentKind, IconComponent> = {
  'claude-code': ClaudeCodeIcon,
  codex: OpenAIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  shell: SquareChevronRight,
}

/** The agent-kind icon — shown right after the status dot, with the kind's name
 *  ("Claude", "Shell", …) on the hover title in place of the old text badge.
 *  `chip` renders it inside a 20px rounded chip (agent rows in the work list). */
export function KindIcon({
  kind,
  dimmed = false,
  chip = false,
}: {
  kind: AgentKind
  dimmed?: boolean
  chip?: boolean
}): JSX.Element {
  const Icon = KIND_ICON[kind]
  // Claude's brand clay for its glyph; other kinds stay text-toned like the mock.
  const tone = dimmed
    ? 'text-muted-foreground/70'
    : kind === 'claude-code'
      ? 'text-claude'
      : 'text-foreground'
  if (chip) {
    return (
      <span
        className={`flex size-5 flex-none items-center justify-center rounded-[5px] bg-[#22222c] transition-colors group-hover:bg-[#2c2c38] ${tone}`}
        title={panelLabel(kind)}
      >
        <Icon size={12} aria-label={panelLabel(kind)} />
      </span>
    )
  }
  return (
    <span className={`flex-none ${tone}`} title={panelLabel(kind)}>
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
export function WorkerLabel({
  session,
  chip = false,
}: {
  session: SessionMeta
  /** Wrap the kind icon in the 20px agent chip (work-list agent rows). */
  chip?: boolean
}): JSX.Element {
  const name = session.handoffTarget
    ? 'Handing off → ' + session.handoffTarget
    : sessionDisplayName(session)
  return (
    <span className="worker-label inline-flex min-w-0 items-center gap-2">
      <KindIcon
        kind={session.agentKind}
        chip={chip}
        dimmed={session.status === 'hibernated' || session.status === 'exited'}
      />
      <span className="worker-name overflow-hidden text-ellipsis whitespace-nowrap" title={name}>
        {name}
      </span>
    </span>
  )
}
