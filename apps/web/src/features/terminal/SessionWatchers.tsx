/**
 * WHO ELSE IS ON THIS SESSION (POD-1535) — the product surface for ADR 7's
 * rooms, and Phase 6's second named multi-user deliverable
 * (`docs/multi-user-readiness.md` §5).
 *
 * Shared terminals are the cheapest collaboration surface in the product
 * (§2): one driver, N watchers, already substrated by `Session.controllerId`.
 * What was missing was identity on it. This strip is that.
 *
 * ---------------------------------------------------------------------------
 * THE TWO STATES, AND WHY THEY MUST NOT LOOK ALIKE
 * ---------------------------------------------------------------------------
 *
 * Presence is stream · live: lossy, dropped rather than buffered, and answered
 * on failure with one reason-free frame. So "we do not know who is here" is a
 * real state and it is NOT "nobody is here". The view type carries no member
 * list while the answer is unknown, and this component renders the two
 * differently and says so in words:
 *
 *   unknown  → a dimmed glyph, no count, "Presence unavailable"
 *   present  → chips for the others, or a quiet "Only you"
 *
 * `data-presence-status` puts the distinction in the DOM so it is testable.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (apps/web/DESIGN.md)
 * ---------------------------------------------------------------------------
 *
 * Chips are NEUTRAL, deliberately: The Reserved Hues Rule keeps the signal
 * hues and terracotta out of identity, and a per-person hue palette would
 * collide with the issue-color channel this header is already tinted by.
 * Identity reads from the mono token, not from colour. Machine voice (ids,
 * counts) is Geist Mono per The Machine Voice Rule. No motion — presence
 * changes are state, not activity, and the Agent State Grammar reserves
 * perpetual motion for an agent actually computing.
 */

import type { SessionId } from '@podium/model'
import { useCurrentPrincipal, usePresenceRoom } from '@podium/client-core/react'
import { Bot, Users } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { MAX_WATCHER_CHIPS, watchersOf, watchersSummary } from './watchers'

export interface SessionWatchersProps {
  readonly sessionId: SessionId
  /**
   * Which pane this connection is reading — the room's opaque payload (D9.3).
   * It is "what I am looking at", the honest small sibling of a text cursor;
   * a cursor inside a shared document is the reserved `document` room kind and
   * is deliberately not built here.
   */
  readonly view: 'chat' | 'native'
  readonly className?: string
}

export function SessionWatchers({
  sessionId,
  view,
  className,
}: SessionWatchersProps): JSX.Element {
  // Rebuilt per render on purpose: the hook compares rooms by value, and the
  // payload is this connection's own presence, republished when it changes.
  const room = useMemo(() => ({ kind: 'session' as const, id: sessionId }), [sessionId])
  const payload = useMemo(() => ({ view }), [view])
  const presence = usePresenceRoom(room, payload)
  const principal = useCurrentPrincipal()

  const watchers = useMemo(
    () => (presence.status === 'present' ? watchersOf(presence.members, principal?.userId ?? null) : []),
    [presence, principal],
  )
  const summary = watchersSummary(presence.status, watchers)
  const shown = watchers.slice(0, MAX_WATCHER_CHIPS)
  const overflow = watchers.length - shown.length

  return (
    <span
      data-testid="session-watchers"
      data-presence-status={presence.status}
      className={cn('inline-flex flex-none items-center', className)}
      title={summary}
      aria-label={summary}
    >
      {presence.status === 'unknown' || watchers.length === 0 ? (
        <Users
          size={12}
          aria-hidden="true"
          className={cn(
            presence.status === 'unknown' ? 'text-(--issue-faint)' : 'text-(--issue-muted)',
          )}
        />
      ) : (
        <span className="inline-flex items-center">
          {shown.map((watcher) => (
            <span
              key={watcher.key}
              data-testid="session-watcher-chip"
              className="-ml-[4px] inline-flex size-[18px] flex-none items-center justify-center rounded-full border issue-hairline-45 bg-secondary font-mono text-[8.5px] font-medium tracking-[0.02em] text-(--issue-bright) first:ml-0"
            >
              {watcher.isAgent ? <Bot size={10} aria-hidden="true" /> : watcher.initials}
            </span>
          ))}
          {overflow > 0 && (
            <span
              data-testid="session-watcher-overflow"
              className="-ml-[4px] inline-flex h-[18px] flex-none items-center justify-center rounded-full border issue-hairline-45 bg-secondary px-[5px] font-mono text-[8.5px] tabular-nums text-(--issue-muted)"
            >
              +{overflow}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
