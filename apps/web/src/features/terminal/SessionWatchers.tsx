

import { useCurrentPrincipal, usePresenceRoom } from '@podium/client-core/react'
import type { SessionId } from '@podium/model/browser'
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

export function SessionWatchers({ sessionId, view, className }: SessionWatchersProps): JSX.Element {
  // Rebuilt per render on purpose: the hook compares rooms by value, and the
  // payload is this connection's own presence, republished when it changes.
  const room = useMemo(() => ({ kind: 'session' as const, id: sessionId }), [sessionId])
  const payload = useMemo(() => ({ view }), [view])
  const presence = usePresenceRoom(room, payload)
  const principal = useCurrentPrincipal()

  const watchers = useMemo(
    () =>
      presence.status === 'present' ? watchersOf(presence.members, principal?.userId ?? null) : [],
    [presence, principal],
  )
  const summary = watchersSummary(presence.status, watchers)
  const shown = watchers.slice(0, MAX_WATCHER_CHIPS)
  const overflow = watchers.length - shown.length

  return (
    <span
      // One named graphic, as the other header glyphs do (`AgentStatusGlyph`,
      // `StatusBadge`) — the chips are a picture of the room and the sentence
      // is its name. Deliberately NOT a live region: presence changes
      // constantly and announcing every join would talk over the work.
      role="img"
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
            presence.status === 'unknown' ? 'text-(--text-faint)' : 'text-(--label)',
          )}
        />
      ) : (
        <span className="inline-flex items-center">
          {shown.map((watcher) => (
            <span
              key={watcher.key}
              data-testid="session-watcher-chip"
              className="-ml-[4px] inline-flex size-[18px] flex-none items-center justify-center rounded-full border surface-hairline-45 bg-secondary font-mono shell-type-micro font-medium tracking-[0.02em] text-(--foreground) first:ml-0"
            >
              {watcher.isAgent ? <Bot size={10} aria-hidden="true" /> : watcher.initials}
            </span>
          ))}
          {overflow > 0 && (
            <span
              data-testid="session-watcher-overflow"
              className="-ml-[4px] inline-flex h-[18px] flex-none items-center justify-center rounded-full border surface-hairline-45 bg-secondary px-[5px] font-mono shell-type-micro tabular-nums text-(--label)"
            >
              +{overflow}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
