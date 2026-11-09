/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * user-focus, and runtime access seams the non-React engine and the thin React
 * binding both speak. Plain TypeScript — no React imports (that's the point of
 * the engine split: everything here must be consumable by a native/headless
 * client).
 */

import type { IssueUpdatePatch } from '@podium/commands'
import type { SessionId } from '@podium/model'
import type { PodiumClientApi } from '../api'

export interface IssuesCommands<_TApi extends PodiumClientApi = PodiumClientApi> {
  /**
   * PATCH AN ISSUE — the generic curation write (POD-781). Optimistic +
   * outboxed: the row repaints on the press instead of after the round trip,
   * which is what an inline rename, a colour, a pin, a stage move and a
   * drag-reorder all needed and none of them had.
   *
   * One action for one command. `patch` is the contract's own patch type, so
   * every field `issues.update` accepts is reachable here without this signature
   * growing a case per field.
   */
  update: (id: string, patch: IssueUpdatePatch) => Promise<void>
  /**
   * DISMISS an issue — `issues.archive`, the sidebar's one-way archive.
   *
   * Distinct from `updateIssue(id, { archived })` ON PURPOSE: they are two
   * commands, and the sidebar's dismiss has always called this one while the
   * context menu's archive/unarchive TOGGLE calls the patch. Collapsing them
   * here would silently re-route one surface's writes through the other's
   * contract.
   */
  archive: (id: string) => Promise<void>
  /**
   * TOMBSTONE an issue and, server-side, every session on it. Optimistic +
   * outboxed: the row and its nested sessions leave the sidebar on the press.
   * Soft: `issues.restore` brings both back.
   */
  delete: (id: string) => Promise<void>
  /**
   * CLOSE an issue — `issues.close`, the menu's Done / Won't fix pair.
   *
   * Not `updateIssue(id, {stage:'done', closedReason})` even though that is what
   * the server's close does internally: the close command also carries the acting
   * session into `issue.closed` (so the steward does not nudge the session that
   * asked for the close) and refuses a proposed issue for an agent caller.
   * Optimistic + outboxed — the row reaches the Closed fold on the press.
   */
  close: (id: string, reason?: string) => Promise<void>
  /** SNOOZE an issue until an instant, a bare date, or `next-message` — `null`
   *  clears quietly. Optimistic + outboxed. */
  defer: (id: string, until: string | null) => Promise<void>
  /** END a snooze the loud way (issue #133): backdates `deferUntil` so the row
   *  floats to the top of WORK wearing "Unsnoozed", rather than clearing it the
   *  way `deferIssue(id, null)` does. Optimistic + outboxed. */
  undefer: (id: string) => Promise<void>
  /** UNDO a delete — `issues.restore`, `manage` authority: the issue comes back
   *  and, server-side, the exact sessions its delete tombstoned. Optimistic +
   *  outboxed, and a delete still QUEUED collapses against it, so the undo of a
   *  fresh mistake never reaches the server at all. */
  restore: (id: string) => Promise<void>
  /** REWRITE an issue's whole label set — `issues.setLabels`, `manage` authority.
   *  The caller sends the set it wants, not a delta. Optimistic + outboxed. */
  setLabels: (id: string, labels: string[]) => Promise<void>
  /**
   * MOVE discovered work between "part of the mission" and "its own thing"
   * (POD-679) — `issues.setPlacement`, one command so the parent link and the
   * provenance edge can never disagree.
   *
   * Optimistic + outboxed: the row leaves or joins the mission on the press. The
   * overlay paints the parent link only — the edge is derived server-side — so
   * the placement CHIP settles a round trip behind the row it describes.
   */
  setPlacement: (id: string, placement: 'own' | 'mission', originId: string) => Promise<void>
  /** Tuck a finished issue into the sidebar's Closed fold, or bring it back
   *  (POD-333): stamp tuckedAt = now / null. Optimistic + outboxed, so the row
   *  folds on the press and the dismissal is SERVER state — it survives a
   *  different browser and every other client folds the same row. */
  setTucked: (id: string, tucked: boolean) => Promise<void>
  /** Mark an issue read. Automatic receipts pass the observed activity;
   * explicit gestures omit it for a covering server cursor. Outboxed. */
  markRead: (id: string, readAt?: string) => Promise<void>
  /** Mark an issue UNREAD again (issue #138, email-style inverse of markIssueRead):
   *  stamp readAt = null so derived `unread` flips back to true. Optimistic + outboxed. */
  markUnread: (id: string) => Promise<void>
  /** Decline the standing offer without answering it [spec:SP-c7f1] — the third
   *  exit, next to pressing a button and letting the next turn clear it.
   *
   *  SHARED state, not a local hide: the offer is a fact about the session, so
   *  the dismissal leaves every surface and every viewer. OUTBOXED since
   *  POD-1110 (`offline: 'eligible'`) — it survives an offline gap like every
   *  other row edit, and the queued entry paints the offer away while it waits.
   *  A replay is safe by construction: the write names ONE offer by its
   *  `offerCreatedAt`, and the server refuses a dismissal whose stamp no longer
   *  matches the standing offer.
   *
   *  Callers need no optimistic hide and no rollback of their own: the entry is
   *  the optimistic apply, and a definitive refusal drops the paint and toasts. */
  dismissOffer: (sessionId: SessionId, offerCreatedAt: string) => Promise<void>
}
