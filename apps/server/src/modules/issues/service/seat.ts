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
 *
 * ONE HUMAN PER CHAIN (POD-6296, design §2.3). "The user" is the session's own
 * human: the person it belongs to. A coordinator counts only while it acts for that
 * same human, so Bob's worker under a task Alice's agent coordinates skips Alice's
 * coordinator and asks the nearest of Bob's, or Bob. A top coordinator of Bob's on
 * Alice's task asks Bob, never the task's assignee. On a one-member instance every
 * session has the same human and nothing is skipped.
 */

import type { IssueId, SessionId, UserId } from '@podium/model'
import type { IssueRow } from '../../../store/types'

export interface SeatCoordinator {
  issueId: IssueId
  /** Human-facing ref (`POD-12`), as commands take it. */
  ref: string
  title: string
  sessionId: SessionId
}

export type SessionSeat =
  /** No coordinator above: this session talks to the user. `claimable` is the
   *  ref of its own issue when nobody coordinates it, so the seat line can say
   *  the role is open rather than read as settled (POD-2062). */
  | {
      kind: 'top'
      coordinates: boolean
      claimable?: string
      /** The session's own human by name, when the instance is shared (POD-6296). */
      human?: string
    }
  /** Below a coordinator: ask it, never the user. */
  | { kind: 'below'; coordinates: boolean; coordinator: SeatCoordinator }

export interface SeatFacts {
  /** One row by id; the database's answer since POD-6158, so it may await. */
  row(id: IssueId): IssueRow | undefined | Promise<IssueRow | undefined>
  isClosed(row: IssueRow): boolean
  /** The session still exists and is not archived; read by id since POD-6160. */
  sessionLive(sessionId: SessionId): boolean | Promise<boolean>
  ref(row: IssueRow): Promise<string>
  /** The human a session acts for: its owner (POD-6283). Undefined when unknown. */
  sessionHuman(sessionId: SessionId): UserId | undefined | Promise<UserId | undefined>
}

export async function resolveSeat(
  sessionId: SessionId,
  issueId: IssueId | null | undefined,
  facts: SeatFacts,
): Promise<SessionSeat> {
  const own = issueId ? await facts.row(issueId) : undefined
  const coordinates = own?.coordinatorSessionId === sessionId
  const human = await facts.sessionHuman(sessionId)
  const seen = new Set<string>()
  for (
    let row = own;
    row && !seen.has(row.id);
    row = row.parentId ? await facts.row(row.parentId) : undefined
  ) {
    seen.add(row.id)
    const marker = row.coordinatorSessionId
    if (!marker || marker === sessionId) continue
    if (facts.isClosed(row) || !(await facts.sessionLive(marker))) continue
    // Another human's coordinator is never this session's to ask.
    if (human !== undefined && (await facts.sessionHuman(marker)) !== human) continue
    return {
      kind: 'below',
      coordinates,
      coordinator: {
        issueId: row.id,
        ref: await facts.ref(row),
        title: row.title,
        sessionId: marker,
      },
    }
  }
  return own && !coordinates
    ? { kind: 'top', coordinates, claimable: await facts.ref(own) }
    : { kind: 'top', coordinates }
}

// The unified mail CLI: `podium issue mail send` takes no --expect-response, and a
// coordinator above sits outside the asking session's subtree, so the send must
// confirm the scope (both RUN 2026-10-15).
const askCommand = (c: SeatCoordinator): string =>
  `\`podium mail send --to ${c.ref} --body "…" --expect-response --outside-scope\``

/** The `podium:seat` instruction and the seat line in `prime`. */
export function seatText(seat: SessionSeat): string {
  const leads = seat.coordinates
    ? ' You coordinate this issue: sessions on it and below it ask you through issue mail. Answer them; bring to the user only what you cannot decide.'
    : ''
  if (seat.kind === 'top') {
    const open = seat.claimable
      ? ` This issue has no active coordinator. If the user named you coordinator or you orchestrate other agent sessions, claim it: \`podium issue coordinator ${seat.claimable} --claim\`.`
      : ''
    const user = seat.human ? ` (${seat.human}, the person you act for)` : ''
    return `Your seat: no coordinator sits above you, so you talk to the user${user} directly (questions, \`podium offer\`).${leads}${open}`
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
