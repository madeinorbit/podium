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
import type { SessionMeta } from '@podium/model'
import type { JSX } from 'react'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { cn } from '@/lib/utils'

export function IssueFleetSummary({
  sessions,
  unread = false,
  size = 18,
  className,
}: {
  sessions: SessionMeta[]
  /** An unopened update since last read (POD-293): a single info dot on the
   *  agent identity, not a shouted banner. Bound to the fleet glyph so it reads
   *  as "this agent has something new", never a free-floating third dot. */
  unread?: boolean
  /** Tile edge in px — 18 in the sidebar, 16 on the denser board card, where an
   *  18px tile of saturated terracotta was the loudest thing on the card and won
   *  the first look from the title. */
  size?: number
  className?: string
}): JSX.Element | null {
  const { present, tiles, nativeCount, label: presenceLabel } = deriveFleetPresence(sessions)
  if (present.length === 0) return null
  const shown = tiles.slice(0, FLEET_KIND_LIMIT)
  // The unread clause is the component's to add, not the viewmodel's: the dot is
  // `aria-hidden` and rides this glyph, so without it a screen reader gets no
  // unread signal at all. It stays out of `deriveFleetPresence` because unread is
  // a read-state fact about the issue, not about who is on it.
  const label = unread ? `${presenceLabel} · new update` : presenceLabel
  const glyph = Math.round(size * 0.66)
  return (
    <span
      className={cn('flex flex-none items-center gap-[5px]', className)}
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-fleet-summary"
    >
      <span className="flex items-center pl-1">
        {shown.map(({ kind, parked }, index) => {
          const AgentIcon = agentIconFor(kind)
          // Per-kind tint (POD-293): Claude wears its clay, other harnesses a
          // quiet navy — solid fills so stacked tiles don't ghost through each
          // other. A table keyed by kind, not a comparison (see @/lib/agent-tone).
          // A parked kind drops the brand for the muted pair (POD-756).
          const tileTint = agentFleetTileTint(kind, parked)
          // The row's unopened-update dot rides the corner of the LAST tile (the
          // artifact's `.fleet-tile .dot`): tight to the glyph at -3px, ringed in
          // the surface it sits on — "this fleet has something new", not a third
          // free-floating mark. The ring reads the ground off the host: a tinted
          // sidebar row publishes `--row-bg`, everything else names its base
          // (`--issue-base`, `--card` on a board card), and an untinted row falls
          // through to the sidebar itself.
          const showDot = unread && index === shown.length - 1
          return (
            <span
              key={kind}
              data-agent-kind={kind}
              data-parked={parked ? '' : undefined}
              className={cn(
                'relative flex items-center justify-center rounded-[5px] border',
                tileTint,
                index > 0 && '-ml-[5px]',
              )}
              style={{ zIndex: index + 1, width: size, height: size }}
            >
              {AgentIcon ? <AgentIcon size={glyph} strokeWidth={1.8} aria-hidden="true" /> : '✳'}
              {showDot && (
                <span
                  className="absolute -top-[3px] -right-[3px] z-[1] size-[7px] rounded-full border-[1.5px] border-[var(--row-bg,var(--issue-base,var(--sidebar)))] bg-info"
                  data-testid="row-unread-dot"
                  aria-hidden="true"
                />
              )}
            </span>
          )
        })}
      </span>
      {present.length > 1 && (
        <span
          className="font-mono text-[9.5px] tabular-nums text-text-dim"
          data-testid="issue-fleet-total"
        >
          {present.length}
        </span>
      )}
      {nativeCount > 0 && (
        <span
          className="rounded-[5px] border border-claude/35 bg-claude/12 px-[3px] font-mono text-[9.5px] leading-[14px] text-claude"
          data-testid="issue-fleet-subagent-count"
        >
          ×{nativeCount}
        </span>
      )}
    </span>
  )
}
