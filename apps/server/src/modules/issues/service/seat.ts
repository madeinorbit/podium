/**
 * THE SEAT RULE (POD-6108, ANALYSIS.md D3 + D5).
 *
 * A session's seat answers one question: may it talk to the user, or does it ask a
 * coordinator? Only a session with no coordinator above it may talk to the user —
 * the top coordinator, or the lone session of a single-issue mission. Every other
 * session asks the NEAREST coordinator at or above its own issue, by issue mail.
 *
 * Derived, never stored: the only fact is each issue's `coordinatorSessionId`. A
 * marker counts only while it can answer — the issue is open and the session still
 * exists unarchived — so a coordinator that is gone never leaves a session blocked
 * with nobody to ask. The walk skips the session's OWN marker: a phase lead asks the
 * coordinator above it, and the top coordinator asks nobody.
 */

import type { IssueId, SessionId } from '@podium/model'
import type { IssueRow } from '../../../store/types'

export interface SeatCoordinator {
  issueId: IssueId
  /** Human-facing ref (`POD-12`), as commands take it. */
  ref: string
  title: string
  sessionId: SessionId
}

export type SessionSeat =
  /** No coordinator above: this session talks to the user. */
  | { kind: 'top'; coordinates: boolean }
  /** Below a coordinator: ask it, never the user. */
  | { kind: 'below'; coordinates: boolean; coordinator: SeatCoordinator }

export interface SeatFacts {
  row(id: IssueId): IssueRow | undefined
  isClosed(row: IssueRow): boolean
  /** The session still exists and is not archived. */
  sessionLive(sessionId: SessionId): boolean
  ref(row: IssueRow): Promise<string>
}

export async function resolveSeat(
  sessionId: SessionId,
  issueId: IssueId | null | undefined,
  facts: SeatFacts,
): Promise<SessionSeat> {
  const own = issueId ? facts.row(issueId) : undefined
  const coordinates = own?.coordinatorSessionId === sessionId
  const seen = new Set<string>()
  for (let row = own; row && !seen.has(row.id); row = row.parentId ? facts.row(row.parentId) : undefined) {
    seen.add(row.id)
    const marker = row.coordinatorSessionId
    if (!marker || marker === sessionId) continue
    if (facts.isClosed(row) || !facts.sessionLive(marker)) continue
    return {
      kind: 'below',
      coordinates,
      coordinator: { issueId: row.id, ref: await facts.ref(row), title: row.title, sessionId: marker },
    }
  }
  return { kind: 'top', coordinates }
}

const askCommand = (c: SeatCoordinator): string =>
  `\`podium issue mail send ${c.ref} --body "…" --expect-response\``

/** The `podium:seat` instruction and the seat line in `prime`. */
export function seatText(seat: SessionSeat): string {
  const leads = seat.coordinates
    ? ' You coordinate this issue: sessions on it and below it ask you through issue mail. Answer them; bring to the user only what you cannot decide.'
    : ''
  if (seat.kind === 'top') {
    return `Your seat: no coordinator sits above you, so you talk to the user directly (questions, \`podium offer\`).${leads}`
  }
  const c = seat.coordinator
  return (
    `Your seat: you work under the coordinator of ${c.ref} (${c.title}). You may not ask the user anything and may not post \`podium offer\`; both are blocked for you. ` +
    `Ask your coordinator instead: ${askCommand(c)}, and keep working on whatever does not depend on the answer. ` +
    `Where the issue instructions say to post an offer (for example when you move to review), mail your coordinator instead.${leads}`
  )
}

/** Why a session below a coordinator may not reach the user, and where to ask.
 *  `what` names the refused act ("Asking the user", "`podium offer`"). */
export function seatRefusal(seat: Extract<SessionSeat, { kind: 'below' }>, what: string): string {
  const c = seat.coordinator
  return `${what} is not available to this session: it works under the coordinator of ${c.ref} (${c.title}). Ask the coordinator instead: ${askCommand(c)}`
}

/** The announcement a create returns when it made its caller the coordinator. */
export function becameCoordinatorText(ref: string): string {
  return `You are now the coordinator of ${ref}: you created its first sub-issue. Sessions on it and below it will ask you through issue mail.`
}
