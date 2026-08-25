import { isUnstartedSession, panelLabel } from '@podium/client-core/viewmodels'
import type { AgentKind, SessionMeta } from '@podium/model/browser'
import { SquareChevronRight } from 'lucide-react'
import type React from 'react'
import type { JSX } from 'react'
import { useThemeAppearance } from '@/app/theme'
import { agentChipTint, agentGlyphTone } from '@/lib/agent-tone'
import {
  ClaudeCodeIcon,
  CursorIcon,
  GrokIcon,
  OpenAIcon,
  OpenCodeIcon,
} from '@/lib/icons/AgentIcons'
import { hasOmarchyMark, OmarchyMark } from '@/lib/icons/OmarchyMarks'

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

/** The display name for a session anywhere in the UI: user-set name beats the
 *  live title; a still-unstarted session reads "New session" (its kind already
 *  rides on the adjacent icon) rather than echoing the harness's boot title. */
export function sessionDisplayName(session: SessionMeta): string {
  if (isUnstartedSession(session)) return 'New session'
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
  compact = false,
}: {
  kind: AgentKind
  dimmed?: boolean
  chip?: boolean
  /** The 16px tile. Same object one step down, for a census of them on one row
   *  (the flight deck's collapsed strips) rather than a single agent's row. */
  compact?: boolean
}): JSX.Element {
  const Icon = KIND_ICON[kind]
  const appearance = useThemeAppearance()
  // THE OMARCHY DESIGN DRAWS NO TILE (POD-1531). Every harness mark on that
  // artboard is bare — in the work list, in the deck, in the tab strip — because
  // the profile's separation comes from ruled rows and one accent, not from a
  // stack of brand-coloured chips. So the chip/compact branch below is skipped
  // entirely rather than restyled: a 20px tile with its fill removed is still a
  // 20px hole in a row the design draws at 12.
  if (appearance === 'omarchy' && hasOmarchyMark(kind)) {
    return (
      <OmarchyMark
        kind={kind}
        size={compact ? 10 : chip ? 12 : 13}
        label={panelLabel(kind)}
        className={dimmed ? 'opacity-60' : undefined}
      />
    )
  }
  // Claude's brand clay for its glyph; other kinds stay text-toned like the mock.
  // Table lookups, not comparisons — see apps/web/src/lib/agent-tone.ts.
  // Chip/fleet tints carry their own text tone (Claude is white-on-clay; Grok
  // is the light mark). A second glyph class would fight that. Standalone
  // marks still take the rest-state tone.
  const tone = dimmed ? 'text-muted-foreground/70' : chip || compact ? '' : agentGlyphTone(kind)
  if (chip || compact) {
    // Per-kind tinted tile (POD-293 / POD-912): Claude is opaque clay, Grok is
    // the light mark, other harnesses a quiet navy — solid fills so the chip
    // never ghosts through a neighbour.
    const chipTint = dimmed ? 'border-hairline-bar bg-muted' : agentChipTint(kind)
    const box = compact ? 'size-4 rounded' : 'size-5 rounded-[6px]'
    return (
      <span
        className={`flex ${box} flex-none items-center justify-center border ${chipTint} ${tone} ${dimmed ? 'opacity-60' : ''}`}
        title={panelLabel(kind)}
      >
        <Icon size={compact ? 10 : 12} aria-label={panelLabel(kind)} />
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
  // Mid-move the row says where the session is going — same words as the pane's
  // handover state (POD-337), so the sidebar and the panel read as one event.
  const name = session.handoffTarget
    ? 'Handing over → ' + session.handoffTarget
    : sessionDisplayName(session)
  return (
    // `max-w-full` IS THE ELLIPSIS (POD-1170). `min-w-0` only lifts the flex
    // item's automatic minimum; it does nothing when this label is not a flex
    // item at all. In a BLOCK parent an `inline-flex` is sized shrink-to-fit,
    // and shrink-to-fit floors at the box's min-content width — which
    // `white-space: nowrap` below makes equal to the whole name. So the label
    // grew past its parent, the name never reached its ellipsis, and the deck's
    // agent rows clipped the name mid-glyph and painted it over the ref.
    // Clamping to the parent's width makes the inner flex line overflow instead,
    // which is what the shrink rules below are written for. Cheaper and safer
    // than switching to `flex`: this label sits in an inline run in the tab
    // strip, and block-level here would break the line.
    <span className="worker-label inline-flex min-w-0 max-w-full items-center gap-2">
      <KindIcon
        kind={session.agentKind}
        chip={chip}
        dimmed={session.status === 'hibernated' || session.status === 'exited'}
      />
      {/* `min-w-0` beside the overflow rules, belt and braces: this label is a
          flex item in three different surfaces (the deck's agent rows, the
          sidebar, the tab strip), and a name that refuses to shrink does not
          ellipsis — it paints straight over the ref and the state beside it. */}
      <span
        className="worker-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        title={name}
      >
        {name}
      </span>
    </span>
  )
}
