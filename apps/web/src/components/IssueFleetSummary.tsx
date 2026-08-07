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
 * The composition is unchanged from the sidebar's: up to `max` solid tiles,
 * overlapping left, then a `+N` chip, then the native-subagent multiplier. Per
 * kind tint (POD-293) comes from `@/lib/agent-tone`, which also owns the mark —
 * icon, tint and tone are one question about one key.
 */
import type { SessionMeta } from '@podium/model'
import type { JSX } from 'react'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { cn } from '@/lib/utils'

export function IssueFleetSummary({
  sessions,
  unread = false,
  max = 2,
  size = 19,
  className,
}: {
  sessions: SessionMeta[]
  /** An unopened update since last read (POD-293): a single info dot on the
   *  agent identity, not a shouted banner. Bound to the fleet glyph so it reads
   *  as "this agent has something new", never a free-floating third dot. */
  unread?: boolean
  /** Tiles drawn before the `+N` chip takes over. */
  max?: number
  /** Tile edge in px — 19 in the sidebar, 16 on the denser board card. */
  size?: number
  className?: string
}): JSX.Element | null {
  if (sessions.length === 0) return null
  const shown = sessions.slice(0, max)
  const overflow = Math.max(0, sessions.length - shown.length)
  const nativeCount = sessions.reduce(
    (sum, session) => sum + (session.agentState?.nativeSubagentCount ?? 0),
    0,
  )
  const label = [
    `${sessions.length} agent${sessions.length === 1 ? '' : 's'}`,
    nativeCount > 0 ? `${nativeCount} native subagent${nativeCount === 1 ? '' : 's'}` : null,
    unread ? 'new update' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const glyph = Math.round(size * 0.63)
  return (
    <span
      className={cn('flex flex-none items-center', className)}
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-fleet-summary"
    >
      {shown.map((session, index) => {
        const AgentIcon = agentIconFor(session.agentKind)
        const tileTint = agentFleetTileTint(session.agentKind)
        // The row's unopened-update dot rides the corner of the LAST tile (the
        // concept's `.av .unreaddot`): tight to the glyph at -3px, ringed in the
        // row background — reads as "this fleet has something new", not a third
        // free-floating mark.
        const showDot = unread && index === shown.length - 1
        return (
          <span
            key={session.sessionId}
            data-agent-kind={session.agentKind}
            className={cn(
              'relative flex items-center justify-center rounded-[6px] border',
              tileTint,
              index > 0 && '-ml-1',
            )}
            style={{ zIndex: index + 1, width: size, height: size }}
          >
            {AgentIcon ? <AgentIcon size={glyph} strokeWidth={1.8} aria-hidden="true" /> : '✳'}
            {showDot && (
              <span
                className="absolute -top-[3px] -right-[3px] z-[1] size-[7px] rounded-full border-[1.5px] border-[var(--row-bg,var(--sidebar))] bg-info"
                data-testid="row-unread-dot"
                aria-hidden="true"
              />
            )}
          </span>
        )
      })}
      {overflow > 0 && (
        <span
          className="shell-type-micro -ml-1 flex items-center justify-center rounded-[6px] border border-border-strong bg-chip px-0.5 font-mono text-muted-foreground"
          style={{ zIndex: shown.length + 1, height: size + 2, minWidth: size + 2 }}
        >
          +{overflow}
        </span>
      )}
      {nativeCount > 0 && (
        <span
          className="shell-type-micro -mt-2 -ml-1 rounded-[4px] border border-claude/35 bg-claude/12 px-[3px] font-mono text-claude"
          style={{ zIndex: shown.length + 2 }}
          data-testid="issue-fleet-subagent-count"
        >
          ×{nativeCount}
        </span>
      )}
    </span>
  )
}
