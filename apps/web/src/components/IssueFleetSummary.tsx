/**
 * WHO IS ON THIS TASK, as one stacked mark.
 *
 * Extracted from `features/worklist/UnifiedIssueRow` (POD-591) because the board
 * card needs the SAME answer the sidebar row gives. Before this, the board said
 * "▣ 5" in grey mono and the sidebar said the same thing with harness marks, a
 * live count and an unread dot — two vocabularies for one fact, on two surfaces
 * the operator switches between all day. It lives under `components/` rather
 * than in either feature because it now sits below both.
 *
 * The extraction then DRIFTED (POD-744): the copy here grew per-SESSION tiles
 * with a `+N` overflow chip while the sidebar's original kept per-KIND tiles
 * with a total, so the same testid on two surfaces answered two different
 * questions. This file is now the row's grammar and the row imports it:
 *
 *   up to {@link FLEET_KIND_LIMIT} harness-KIND tiles, the agent total once
 *   there is more than one, then `×N` for native (in-process Task) children.
 *
 * Kinds, not sessions. A nine-agent mission running three harnesses shows three
 * tiles and a `9`, not nine tiles or `2 +7` — the stack answers "who is here",
 * the number answers "how many". It is also what the phone row renders, so this
 * is one grammar on all three surfaces.
 *
 * WHO IT DRAWS is `deriveFleetPresence`'s call (POD-756), not this component's:
 * agents on the task, PARKED ones ghosted rather than dropped, archived and
 * exited ones gone. Everything is derived from the caller's session set; nothing
 * is stored on the issue.
 *
 * Per-kind tint (POD-293) comes from `@/lib/agent-tone`, which also owns the
 * mark — icon, tint and tone are one question about one key.
 */
import { deriveFleetPresence, FLEET_KIND_LIMIT } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'
import type { JSX } from 'react'
import { useThemeAppearance } from '@/app/theme'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { hasOmarchyMark, OmarchyMark } from '@/lib/icons/OmarchyMarks'
import { cn } from '@/lib/utils'

export function IssueFleetSummary({
  sessions,
  size = 18,
  variant = 'tiles',
  className,
}: {
  sessions: SessionMeta[]
  /** Tile edge in px — 18 in the sidebar, 16 on the denser board card, where an
   *  18px tile of saturated terracotta was the loudest thing on the card and won
   *  the first look from the title. In `glyphs` this is the GLYPH's own size. */
  size?: number
  /** How loudly the stack speaks (POD-1057). `tiles` — a brand-tinted chip per
   *  harness kind — is right on a board card, where the card is the object.
   *  `glyphs` is the 3a work row's: the same marks, unboxed, at one ink with the
   *  rest of line 2, because thirty stacks of coloured chips down a column was
   *  the first thing the eye landed on, ahead of every title. */
  variant?: 'tiles' | 'glyphs'
  className?: string
}): JSX.Element | null {
  const { present, tiles, nativeCount, label } = deriveFleetPresence(sessions)
  const appearance = useThemeAppearance()
  if (present.length === 0) return null
  const shown = tiles.slice(0, FLEET_KIND_LIMIT)
  const glyphs = variant === 'glyphs'
  const glyph = glyphs ? size : Math.round(size * 0.66)
  // The head-count. In `glyphs` it appears only when the marks UNDER-count —
  // nine agents across three harnesses draw three glyphs, and leaving it there
  // would be a lie by omission — where the boxed stack always shows it past one.
  const showTotal = present.length > (glyphs ? shown.length : 1)
  return (
    <span
      className={cn('flex flex-none items-center', glyphs ? 'gap-1' : 'gap-[5px]', className)}
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-fleet-summary"
      data-variant={variant}
    >
      <span className={cn('flex items-center', glyphs ? 'gap-1' : 'pl-1')}>
        {shown.map(({ kind, parked }, index) => {
          const AgentIcon = agentIconFor(kind)
          return (
            <span
              key={kind}
              data-agent-kind={kind}
              data-parked={parked ? '' : undefined}
              className={cn(
                'relative flex items-center justify-center',
                // GLYPHS carry no ground: one ink a step below the words they
                // lead, and parked ghosts rather than disappears — a stopped
                // teammate is still on the task. TILES take the per-kind tint
                // (POD-293 / POD-912) as a solid fill, so a stack of them does
                // not ghost through itself.
                glyphs
                  ? cn('flex-none text-text-dim', parked && 'opacity-45')
                  : cn(
                      'rounded-[5px] border',
                      agentFleetTileTint(kind, parked),
                      index > 0 && '-ml-[5px]',
                    ),
              )}
              style={glyphs ? undefined : { zIndex: index + 1, width: size, height: size }}
            >
              {appearance === 'omarchy' && hasOmarchyMark(kind) ? (
                // The supplied mark, at the supplied fill — the row's state
                // picks which of the six files paints it (omarchy.css).
                <OmarchyMark kind={kind} size={glyph} />
              ) : AgentIcon ? (
                <AgentIcon size={glyph} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <span style={glyphs ? { fontSize: size } : undefined}>✳</span>
              )}
            </span>
          )
        })}
      </span>
      {showTotal && (
        <span
          className={cn('font-mono tabular-nums text-text-dim', !glyphs && 'shell-type-micro')}
          data-testid="issue-fleet-total"
        >
          {present.length}
        </span>
      )}
      {nativeCount > 0 && (
        <span
          className={cn(
            'font-mono tabular-nums',
            glyphs
              ? 'text-text-dim'
              : 'rounded-[5px] border border-claude/35 bg-claude/12 px-[3px] shell-type-micro leading-[14px] text-claude',
          )}
          data-testid="issue-fleet-subagent-count"
        >
          ×{nativeCount}
        </span>
      )}
    </span>
  )
}
