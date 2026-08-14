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
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
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
  /** How loudly the stack speaks (POD-1057).
   *
   *  `tiles` is the original: a rounded, brand-tinted chip per harness kind. It
   *  is right on a board card, where the card is the object and the fleet is one
   *  of four facts on it.
   *
   *  `glyphs` is the 3a work row's: the same marks, unboxed, at one ink with the
   *  rest of line 2. A worklist column is thirty rows deep and the fleet is the
   *  quietest fact in each of them — thirty stacks of coloured chips was the
   *  first thing the eye landed on, ahead of every title. Same derivation, same
   *  accessible label; only the volume changes. */
  variant?: 'tiles' | 'glyphs'
  className?: string
}): JSX.Element | null {
  const { present, tiles, nativeCount, label } = deriveFleetPresence(sessions)
  if (present.length === 0) return null
  const shown = tiles.slice(0, FLEET_KIND_LIMIT)
  const glyph = Math.round(size * 0.66)
  if (variant === 'glyphs') {
    return (
      <span
        className={cn('flex flex-none items-center gap-1', className)}
        role="img"
        aria-label={label}
        title={label}
        data-testid="issue-fleet-summary"
        data-variant="glyphs"
      >
        {shown.map(({ kind, parked }) => {
          const AgentIcon = agentIconFor(kind)
          return (
            <span
              key={kind}
              data-agent-kind={kind}
              data-parked={parked ? '' : undefined}
              // One ink for every harness, a step below the words beside it: the
              // mark answers WHICH agent by silhouette, and the status phrase it
              // leads is the thing being read. Parked agents ghost rather than
              // disappear — a stopped teammate is still on the task.
              className={cn('flex flex-none items-center text-text-dim', parked && 'opacity-45')}
            >
              {AgentIcon ? (
                <AgentIcon size={size} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <span style={{ fontSize: size }}>✳</span>
              )}
            </span>
          )
        })}
        {/* The head-count appears only when the marks UNDER-COUNT — nine agents
            across three harnesses draw three glyphs, and "3" would be a lie by
            omission. One or two agents of one kind each are already counted by
            their own marks, so the number would be the same fact twice. */}
        {present.length > shown.length && (
          <span className="font-mono tabular-nums text-text-dim" data-testid="issue-fleet-total">
            {present.length}
          </span>
        )}
        {nativeCount > 0 && (
          <span
            className="font-mono tabular-nums text-text-dim"
            data-testid="issue-fleet-subagent-count"
          >
            ×{nativeCount}
          </span>
        )}
      </span>
    )
  }
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
          // Per-kind tint (POD-293 / POD-912): solid fills so stacked tiles
          // don't ghost through each other. Claude is opaque clay, Grok is the
          // light mark. Unread no longer rides a tile — kinds collapse and grow
          // ×N, so a corner dot cannot mean per-session newness.
          const tileTint = agentFleetTileTint(kind, parked)
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
            </span>
          )
        })}
      </span>
      {present.length > 1 && (
        <span
          className="font-mono shell-type-micro tabular-nums text-text-dim"
          data-testid="issue-fleet-total"
        >
          {present.length}
        </span>
      )}
      {nativeCount > 0 && (
        <span
          className="rounded-[5px] border border-claude/35 bg-claude/12 px-[3px] font-mono shell-type-micro leading-[14px] text-claude"
          data-testid="issue-fleet-subagent-count"
        >
          ×{nativeCount}
        </span>
      )}
    </span>
  )
}
