/**
 * The pure half of the session watcher strip (POD-1535) — who is in the room,
 * as labels, with no React and no transport.
 *
 * IDENTITY IS SHOWN, NOT RESOLVED. Per-user authentication is Phase 3
 * (POD-315), so there is no directory to turn a `UserId` into a name yet. The
 * strip is honest about that: it shows a short token derived from the id the
 * server stamped, and "You" for the current principal. Nothing here invents a
 * display name, and nothing derives identity from anywhere but the presence
 * frame the server sent (ADR 3 D7 — payload identity is inert).
 */

import type { PresenceMember } from '@podium/protocol'

/** How many chips the strip shows before collapsing the rest into "+N". */
export const MAX_WATCHER_CHIPS = 3

export interface Watcher {
  /** Stable key — the identity, not the array index. */
  readonly key: string
  /** Two-character token for the chip face. */
  readonly initials: string
  /** Full sentence for the tooltip / screen reader. */
  readonly label: string
  readonly isAgent: boolean
}

/** The last meaningful segment of an opaque id: `user:alice` → `alice`. */
const tail = (id: string): string => {
  const parts = id.split(/[:/_-]/).filter(Boolean)
  return parts[parts.length - 1] ?? id
}

const initialsOf = (id: string): string => tail(id).slice(0, 2).toUpperCase()

/**
 * What this watcher is looking at, from the room's opaque payload (ADR 7 D9.3
 * — the port never interprets it, so the reading lives here with the room
 * kind's owner). Anything unrecognised reads as nothing rather than as a guess.
 */
export const watcherFocus = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) return null
  const view = (payload as { view?: unknown }).view
  if (view === 'chat') return 'chat'
  if (view === 'native') return 'the terminal'
  return null
}

/**
 * Turn the room's members into chips. `selfUserId` is the current principal's
 * user id, and its member is dropped: the strip answers "who ELSE is here".
 * A member is dropped only on an exact id match — never on a heuristic — so a
 * second device of your own still shows as one entry rather than silently
 * disappearing.
 */
export function watchersOf(
  members: readonly PresenceMember[],
  selfUserId: string | null,
): readonly Watcher[] {
  const out: Watcher[] = []
  for (const member of members) {
    const focus = watcherFocus(member.payload)
    const watching = focus ? ` — watching ${focus}` : ''
    if (member.identity.kind === 'user') {
      const userId = String(member.identity.user)
      if (selfUserId !== null && userId === selfUserId) continue
      out.push({
        key: `u:${userId}`,
        initials: initialsOf(userId),
        label: `${userId} is here${watching}`,
        isAgent: false,
      })
      continue
    }
    const agentId = String(member.identity.agentIdentity)
    const onBehalfOf = String(member.identity.onBehalfOf)
    out.push({
      key: `a:${agentId}@${onBehalfOf}`,
      initials: initialsOf(agentId),
      label: `Agent ${agentId}, for ${onBehalfOf}, is here${watching}`,
      isAgent: true,
    })
  }
  return out
}

/**
 * The strip's one sentence, for the tooltip and the accessible name.
 *
 * THE INVARIANT, IN COPY: `unknown` never produces a count and never produces
 * the word "nobody". "We do not know who is here" and "you are the only one
 * here" are different sentences because they are different facts — presence is
 * lossy by construction (ADR 7's stream plane) and a blank strip must not read
 * as an empty room.
 */
export function watchersSummary(
  status: 'unknown' | 'present',
  watchers: readonly Watcher[],
): string {
  if (status === 'unknown') return 'Presence unavailable — who else is here is unknown'
  if (watchers.length === 0) return 'Only you are here'
  return watchers.map((w) => w.label).join('\n')
}
