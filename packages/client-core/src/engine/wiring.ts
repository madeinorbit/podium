/**
 * Engine transport + write-path wiring (#262 [spec:SP-3fe2]): constructs the
 * SocketHub (metadata delta mode, persist-after-apply into the replica) and the
 * Outbox (durable offline write queue over the replica's storage). Extracted
 * verbatim from react/provider.tsx so the engine — and any non-React client —
 * shares ONE construction path with zero React involvement.
 */

import type { ConfirmationRule } from '@podium/commands'
import {
  isStoppedSend,
  isUnaddressableSend,
  type MutationId,
  type SessionId,
  type WorkState,
} from '@podium/model'
import {
  isMissingSyncSubmit,
  SyncSubmitRefusedError,
  SyncSubmitReply,
  submitNow,
} from '@podium/protocol'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import {
  ENQUEUEABLE_DELIVERY,
  normalizeRefusal,
  type OutboxCommand,
  type OutboxRejectionReason,
  type RetrySatisfaction,
} from '@podium/sync/outbox'
import type { PodiumClientApi } from '../api'
import {
  classifyRefusal,
  type OnlineEvents,
  Outbox,
  type OutboxDeadLetterEntry,
  type OutboxEntry,
  type OutboxSettlement,
  platformIsOnline,
  platformOnlineEvents,
} from '../outbox'
import {
  couldNotSaveNotice,
  recoverableAuthoredText,
  sessionGoneNotice,
} from '../outbox-recovery-copy'
import { recordRevisionChainFor } from '../record-revisions'
import {
  isRecordOutboxKind,
  RECORD_HOMES,
  type RecordEditEntry,
  type RecordKind,
  type RecordOutboxInputs,
  type RecordOutboxKind,
  type RecordRemoveEntry,
  recordDeclaration,
  recordOpOf,
  recordWireCommand,
  recordWireInput,
} from '../records'
import type { Replica } from '../replica/kernel/facade'
import { applyLegacyMetadataState } from '../replica/legacy-wire-v1-binding'
import { LegacyWireV1Feed } from '../replica/legacy-wire-v1-feed'
import { type FeedSinkPort, SocketHub } from '../socket-transport'
import {
  isLegacyOutboxKind,
  LEGACY_AUTOMATIC_KINDS,
  LEGACY_OUTBOX_COMMANDS,
  type LegacyOutboxKind,
  legacyOutboxExecutors,
  submitRecordEditAsLegacy,
  submitRecordRemoveAsLegacy,
} from './legacy-outbox-kinds'
import { assertSendAccepted } from './send-outcome'
import type { StoreNotices } from './types'

/** Outboxed mutation kinds → their tRPC inputs (docs/spec/outbox-write-path.md
 *  §2.3). Each executor replays with the entry's stable mutationId, so the
 *  server dedupes across reload/reconnect. Replicated per-user rows (pins,
 *  tab order, and personal settings) use the same path, and so does every chat
 *  send (POD-4762) — under a give-up window of minutes, not days
 *  (`OUTBOX_COMMAND_MAX_AGE_MS`). */
export type OutboxKinds = {
  /**
   * THE CHAT SENDS (POD-4762). Every message the operator writes to a session —
   * live or parked, online or not — is one of these two, keyed by the message id
   * the composer minted, so the queue's retries and the user's own "retry" all
   * reach the Authority as the SAME message. `sendText` types into the running
   * agent; `resumeAndSend` wakes a parked one first. Neither collapses: two
   * sends are two sends.
   */
  sendText: { sessionId: SessionId; text: string; attachments?: RuntimeAttachmentRef[] }
  /** Attachments ride a wake too: the server holds the files and stages them
   *  when the woken agent is handed the message (POD-2148). */
  resumeAndSend: { sessionId: SessionId; text: string; attachments?: RuntimeAttachmentRef[] }
  /**
   * THE OFFER DISMISSAL (POD-1110) — "none of these", and only that.
   *
   * It carries the offer's `createdAt` because the command means "dismiss THIS
   * offer" and the server matches the stamp, returning false on a mismatch. That
   * is what makes a REPLAY safe here rather than merely tolerable: a dismissal
   * draining after a newer offer was posted is refused by construction, not by
   * luck, so the hazard the old `direct-only` class named cannot happen.
   *
   * The offer's ACTION buttons are the `sendText` kind above: a chat turn,
   * under the chat give-up window rather than this one's.
   */
  dismissOffer: { sessionId: SessionId; offerCreatedAt: string }
  /**
   * THE ISSUE CURATION WRITES (POD-781).
   *
   * ONE GENERIC PATCH KIND rather than one kind per field: the command is `issues.update` and
   * its input is a partial patch, so a `issueRename` / `issueSetPriority` /
   * `issueSetStage` family would be N kinds all naming ONE contract, N routing
   * rows and N overlay cases that differ only in which key they carry. The
   * distinctions those kinds would encode are not distinctions the queue has —
   * same contract, same partition, same collapse answer (none).
   *
   * `issueArchive` and `issueDelete` are separate because they are separate
   * COMMANDS. `issues.archive` is not `issues.update{archived:true}` — the
   * sidebar's dismiss calls the former, the context menu's archive/unarchive
   * TOGGLE calls the latter — and `issues.delete` cascades to member sessions.
   * A kind names a contract; two contracts cannot share one.
   */
  issueUpdate: Omit<Parameters<PodiumClientApi['issues']['update']['mutate']>[0], 'mutationId'>
  issueDelete: { id: string }
  /**
   * THE FOUR THAT ARE NOT `issues.update` (POD-781 group 2), and the rule that
   * decided them: A KIND NAMES A CONTRACT. `issues.close` reaches `update`
   * INTERNALLY — `IssueCrud.close` is `update(id, {stage:'done', closedReason})`
   * — and that is precisely the trap. The command is not its implementation: the
   * close route also emits `issue.closed` with the acting session so the steward
   * can skip nudging it, and refuses a proposed issue for an agent. Queuing a
   * close as `issueUpdate` would drop both, silently, on the offline path only.
   *
   * `issueUndefer` is separate from `issueDefer`: it is another command, and not
   * the same act —
   * `defer(null)` clears quietly, `undefer` BACKDATES so the row floats back to
   * the top of WORK wearing the "Unsnoozed" tag (issue #133).
   */
  issueClose: { id: string; reason?: string }
  /**
   * THE LAST TWO (POD-781 group 3), and both are `issues.update`-adjacent
   * commands that a patch could not stand in for.
   *
   * `issueSetPlacement` writes a PAIR — the provenance edge and the parent link,
   * in an order the server chose so no interleaving leaves the issue top-level
   * with nothing pointing back at where it came from. A patch kind reaches
   * neither: `parentId` is on the issue row but `reparent` maintains the
   * hierarchy around it, and dependency edges are not row fields at all.
   *
   * `issueRestore` is the inverse of `issueDelete` and, like it, is a
   * CROSS-AGGREGATE act: it un-tombstones the issue and the exact sessions its
   * delete killed, in one ledger transaction. `issues.update{deletedAt:null}`
   * would move the issue alone and strand the sessions.
   */
  issueSetPlacement: { id: string; placement: 'own' | 'mission'; originId: string }
  issueRestore: { id: string }
  /**
   * GENERIC SYNCED EDITS (ADR 12 D3, POD-6392): one kind per OP, for every
   * declared record kind. The input names the record kind, so the wire command
   * (`records.<kind>.<op>`) comes from the input rather than from this table
   * ({@link outboxCommandOf}). See `../records.ts`.
   */
  recordCreate: RecordOutboxInputs['recordCreate']
  recordEdit: RecordOutboxInputs['recordEdit']
  recordRemove: RecordOutboxInputs['recordRemove']
  /**
   * EFFECT RECORDS (ADR 12 D5 E2, POD-6408): a one-off action as data. Queued,
   * so a session start made offline still lands; its status comes back on the
   * record, never in the reply.
   */
  effectCreate: import('../spawn-agent').EffectCreateInput
  /** Take an ended effect record off the feed (a failed start's Dismiss). */
  effectDismiss: { id: string }
}

/** The kinds that name one fixed contract. The record kinds name theirs by input. */
export type FixedOutboxKind = Exclude<keyof OutboxKinds, RecordOutboxKind>

/** The engine-facing queue contract. Kernel-backed web clients inject this
 * implementation; legacy and mobile clients keep the compatibility queue. */
export interface EngineOutbox {
  attach(): void
  dispose(): void
  subscribe(listener: (size: number) => void): () => void
  size(): number
  pending(): OutboxEntry[]
  awaiting(): OutboxEntry[]
  deadLetters(): OutboxDeadLetterEntry[]
  enqueue<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
    /**
     * `mutationId` lets the CALLER name the entry before it exists (POD-1053).
     * The optimistic ledger paints ahead of the durable commit, and its overlay
     * has to be filed under the id the entry will carry — the drain can fire
     * `onApplied` before the enqueue's own promise resolves, so learning the id
     * from the return value is too late. Omit it and the queue mints one, which
     * is what every other caller does.
     */
    opts?: { mutationId?: MutationId },
  ): OutboxEntry | Promise<OutboxEntry>
  /** Wait for local queue commits only; pending network delivery may survive reload. */
  flushLocalWrites?(): Promise<void>
  retry(mutationId: MutationId, satisfaction: RetrySatisfaction): unknown
  edit(mutationId: MutationId, input: unknown): unknown
  discard(mutationId: MutationId): unknown
  notifyConnected(): void
  drain(): Promise<void>
}

export interface EngineOutboxCallbacks {
  readonly api: PodiumClientApi
  readonly replica: Replica
  readonly notices: StoreNotices
  readonly onApplied?: (entry: OutboxEntry) => void
  /** Every resolution of an entry, by id, with the Authority's answer — what a
   *  chat send waits on (POD-4762). Fires for entries `onApplied` never sees:
   *  a terminal verdict retires in the same commit that applies it. */
  readonly onSettled?: (mutationId: MutationId, settlement: OutboxSettlement) => void
  /** `reason` is the normalized refusal when the queue knows one (POD-4554:
   *  the receipts stream reports it; nothing else reads it). */
  readonly onDropped?: (entry: OutboxEntry, reason?: OutboxRejectionReason) => void
  readonly onDeadLetter?: (parked: OutboxDeadLetterEntry) => void
  /**
   * The queue collapsed this still-queued entry into a later one with the same
   * collapse key (POD-785), so it will never be sent and never get an outcome.
   * `entry` is what it carried when the queue could still see it. Observation
   * only (POD-4554): the receipts stream reports it. Only the kernel queue
   * collapses; the compatibility queue never calls it.
   */
  readonly onSuperseded?: (mutationId: MutationId, entry: OutboxEntry | undefined) => void
  /**
   * Whether anyone is observing supersedes RIGHT NOW. Naming what a collapsed
   * entry carried costs the kernel queue a scan of its pending records per
   * collapsible enqueue, so it runs only when this answers true (absent means
   * true). The runtime answers "an outcome listener is subscribed", which in
   * production is never: only the round-three prototypes listen (POD-4554).
   */
  readonly observingSupersede?: () => boolean
  /**
   * PLATFORM CONNECTIVITY (POD-2055 WP-C2), when the composition root knows it
   * better than the browser globals below do. Native mobile passes NetInfo:
   * `window`'s `online` event does not exist there, and `navigator.onLine` is
   * undefined — which reads as "always online", so an airplane-mode phone
   * retried every queued write every 5 seconds.
   *
   * Absent ⇒ the browser probes, exactly as before.
   */
  readonly onlineEvents?: OnlineEvents
  readonly isOnline?: () => boolean
}

export type CreateEngineOutbox = (callbacks: EngineOutboxCallbacks) => EngineOutbox

/** `ENQUEUEABLE_DELIVERY` narrowed and nothing else — the same value, reused
 *  rather than re-spelled, so a rename of the class reaches this table. */
const delivery = ENQUEUEABLE_DELIVERY as OutboxCommand['delivery']

/**
 * The CONTRACT TABLE, which `readLegacyReplica`, the outbox binding and the
 * dead-letter recovery surface all refuse to invent (ADR 3 D9): a client entry
 * carries a bare `kind` and an `OutboxCommand` needs `{name, version, delivery}`,
 * so guessing a version would re-author a queued write under a contract its
 * input may not satisfy.
 *
 * It is typed `Record<keyof OutboxKinds, …>` deliberately. That is the only
 * thing standing between this table and silent drift: adding a drainable kind
 * to the engine's queue without a contract here is a TYPE ERROR, rather than an
 * `unknown-command` rejection a user discovers when their offline work fails to
 * migrate.
 *
 * IT LIVES HERE, beside `OutboxKinds`, rather than in one app (POD-316). It used
 * to live in the mobile provider, and the web recovery surface needs the same
 * mapping — two copies would drift, and the thing that drifts is which contract
 * a queued write is replayed under.
 *
 * `confirmation` is the contract's own `policy.confirmation` (ADR 3 D2), carried
 * here so the recovery surface can tell whether an inline confirmation could
 * possibly satisfy a `confirmation-required` refusal WITHOUT importing the whole
 * command registry into the browser bundle (`audit:browser-reach`). It is a copy,
 * and `outbox-contract-table.test.ts` pins it EQUAL to the contract's value.
 *
 * Every version is 1 because every one of these contracts has only ever had one.
 * That is a statement about today, and the day one of them changes, the entry
 * here changes with it.
 */
export const OUTBOX_COMMANDS: Record<
  FixedOutboxKind,
  OutboxCommand & { confirmation: ConfirmationRule }
> = {
  effectCreate: { name: 'effects.create', version: 1, delivery, confirmation: 'none' },
  effectDismiss: { name: 'effects.dismiss', version: 1, delivery, confirmation: 'none' },
  sendText: { name: 'sessions.sendText', version: 1, delivery, confirmation: 'none' },
  resumeAndSend: { name: 'sessions.resumeAndSend', version: 1, delivery, confirmation: 'none' },
  dismissOffer: { name: 'sessions.dismissOffer', version: 1, delivery, confirmation: 'none' },
  // THE FIRST QUEUED KINDS WITH `confirmation: 'confirm'` (POD-781). Every issue
  // WRITE/MANAGE contract carries it, and it is a copy of the contract's value,
  // not a choice made here — `outbox-contract-table.test.ts` pins it EQUAL.
  //
  // IT IS NOT INERT, and it was checked rather than assumed. The recovery
  // surface reads exactly this field (`inlineConfirmationCanSatisfy`) to decide
  // whether to offer "Confirm and retry" on a `confirmation-required` refusal;
  // under `confirm` it offers it, under `broker`/`none` it withholds it and says
  // why. What the field means here is ADR 3 D2's `--outside-scope` gate, which
  // is an AGENT gate: it fires when a subtree-scoped caller writes outside its
  // subtree, arrives as PRECONDITION_FAILED, and an operator capability (scope
  // 'all') short-circuits the target check entirely. This queue belongs to the
  // operator's own client on the tRPC path — where `overrideScope` is a
  // relay-context flag no tRPC input carries — so the refusal is unreachable
  // from here and the affordance never renders. Declaring 'none' to keep it that
  // way would be a lie about the contract AND the arm that tells the user "the
  // server asked for a confirmation this change is not set up to carry", which
  // is the worse of the two failures. Recorded in POD-781's report: were an
  // agent-scoped principal ever to drive this queue, `Outbox.retry` re-queues
  // the entry UNCHANGED, so the confirm button would not yet carry the
  // confirmation through — that is the day this needs threading, not today.
  issueUpdate: { name: 'issues.update', version: 1, delivery, confirmation: 'confirm' },
  issueDelete: { name: 'issues.delete', version: 1, delivery, confirmation: 'confirm' },
  issueClose: { name: 'issues.close', version: 1, delivery, confirmation: 'confirm' },
  // `manage`, not `write` — the same `confirm` rule, reached from MANAGE_POLICY
  // rather than WRITE_POLICY. Copied from the contract either way, and
  // `outbox-contract-table.test.ts` pins it there.
  issueSetPlacement: {
    name: 'issues.setPlacement',
    version: 1,
    delivery,
    confirmation: 'confirm',
  },
  // `manage` again, like `setLabels`: undoing a delete is the heavier authority.
  issueRestore: { name: 'issues.restore', version: 1, delivery, confirmation: 'confirm' },
}

/**
 * Whether a definitive refusal represents authored intent that must wait for a
 * person, or disposable client bookkeeping.
 *
 * This is deliberately keyed by COMMAND KIND, never by the authority's reason:
 * a missing, invisible and forbidden target all take the same branch, so this
 * policy cannot reopen the existence oracle by cleaning up one of them and
 * surfacing another. Unknown commands fail closed into recovery.
 *
 * `issueMarkRead` is emitted eagerly by the foreground-issue reaction. It
 * carries no content and, once its issue has been purged or moved out of scope,
 * there is no useful repair a person can perform. Keeping that receipt as a
 * permission failure misattributes automatic bookkeeping to the user.
 */
export type OutboxDeadLetterHandling = 'recover' | 'discard-automatic'

export const OUTBOX_DEAD_LETTER_HANDLING: Record<keyof OutboxKinds, OutboxDeadLetterHandling> = {
  sendText: 'recover',
  resumeAndSend: 'recover',
  // `recover`, not `discard-automatic`: a dismissal is a decision the operator
  // made with a click, unlike the read receipt the foreground reaction emits on
  // its own. It carries no authored prose, so `shouldParkDeadLetter` still lets
  // a definitive refusal revert-and-toast rather than parking it.
  dismissOffer: 'recover',
  issueUpdate: 'recover',
  issueDelete: 'recover',
  issueClose: 'recover',
  issueSetPlacement: 'recover',
  issueRestore: 'recover',
  // A refused plain edit snaps back and is toasted; one carrying typed text
  // parks for recovery (`shouldParkDeadLetter` reads the input).
  recordCreate: 'recover',
  recordEdit: 'recover',
  recordRemove: 'recover',
  effectCreate: 'recover',
  effectDismiss: 'recover',
}

export function deadLetterHandlingFor(kind: string, input?: unknown): OutboxDeadLetterHandling {
  if (kind === 'recordEdit' && isAutomaticReadReceipt(input)) return 'discard-automatic'
  if (LEGACY_AUTOMATIC_KINDS.has(kind)) return 'discard-automatic'
  return (
    OUTBOX_DEAD_LETTER_HANDLING[kind as keyof OutboxKinds] ??
    // Unknown work may contain authored content. Preserve it for recovery.
    'recover'
  )
}

/**
 * THE AUTOMATIC READ RECEIPT (POD-6404): an edit that only sets my read mark on
 * an issue. The foreground-issue reaction emits it on its own, as it emitted
 * `issueMarkRead` before, so a refusal of it is bookkeeping to drop, never
 * something to put in front of the person. Read off the input, never the target.
 */
function isAutomaticReadReceipt(input: unknown): boolean {
  const edit = input as Partial<RecordOutboxInputs['recordEdit']> | undefined
  if (edit?.kind !== 'issueUserState' || (edit.unset?.length ?? 0) > 0) return false
  const cells = Object.entries(edit.patch ?? {}).filter(([, v]) => v !== undefined)
  return cells.length === 1 && cells[0]?.[0] === 'readAt' && typeof cells[0][1] === 'string'
}

/** Park only when the author typed words we would lose by reverting.
 *  A refused stage click, tuck, or pin just snaps back — Linear-shaped.
 *  Unknown kinds fail closed into recovery. The decision reads the author's
 *  input only, never the target, so it cannot reopen the existence oracle. */
export function shouldParkDeadLetter(kind: string, input: unknown): boolean {
  if (deadLetterHandlingFor(kind, input) === 'discard-automatic') return false
  // A retired kind an older build queued (LEGACY) is known work that carries no
  // typed words: it snaps back like the record edit that replaced it.
  if (!(kind in OUTBOX_DEAD_LETTER_HANDLING) && !isLegacyOutboxKind(kind)) return true
  return recoverableAuthoredText(input) !== null
}

/**
 * POD-785 — WHERE each queued write sits in the queue, and WHETHER a later write
 * of the same kind makes it redundant.
 *
 * Both halves used to be one constant. Every client write went into a single
 * `client-outbox` partition, and ADR 3 D12 then stopped a partition at its first
 * unresolved entry (amendment 2 now releases it on any definitive answer, POD-5430)
 * — so ONE dead-lettered write (a rename refused after a share
 * was revoked, say) wedged the whole queue for ever, while the app kept queueing
 * read receipts behind it at ~361 B each. Measured: 500 receipts behind one
 * parked entry, 0 delivered after three drains. Per-target keys, same workload:
 * everything lands and only the revoked session stays stuck.
 * (docs/internal/pod-785-evidence/)
 *
 * The single-partition choice was inherited from the legacy IMPORT path, where it
 * is argued as "over-serialised and correct" — true for a one-shot drain of a
 * handful of entries, and false for the app's steady-state queue.
 *
 * ## partition — the ORDERING domain
 *
 * The target the write lands on. Two writes to the SAME row must share a key, or
 * they can reorder and a rename lands before the edit it was meant to follow
 * (this is what the legacy `chained` flag tracked). Two writes to DIFFERENT rows
 * must not, or one refusal blocks the other.
 *
 * ## collapse — the REDUNDANCY domain
 *
 * The STATE CELL the write sets, present only when a later write to that cell
 * fully subsumes an earlier one. `undefined` means never collapse, and it is the
 * answer for two whole classes:
 *
 *   - CONTENT-BEARING writes. `resumeAndSend` puts text into a live PTY; two
 *     sends are two sends. ADR 3 D11 names exactly this as the reason
 *     "idempotent-ish" is not a property we may lean on.
 *   - PARTIAL patches. `layout.set` and `layout.clear`
 *     carry only the keys they touch, so a later patch does NOT subsume an
 *     earlier one — collapsing them would silently drop the fields only the first
 *     one set.
 *
 * Where two different commands write the same cell they SHARE a collapse key:
 * `markRead`/`markUnread` on one issue, `snoozeSet`/`snoozeClear` on one session.
 * The newest wins, which is precisely what the user's last click meant.
 *
 * Typed `Record<keyof OutboxKinds, …>` for the same reason as `OUTBOX_COMMANDS`
 * above: adding a queued kind without deciding its ordering and its redundancy is
 * a TYPE ERROR, not a default that silently reinstates the wedge.
 */
export type OutboxRouting = {
  readonly partitionKey: string
  readonly collapseKey?: string
}

export const OUTBOX_ROUTING: {
  [K in keyof OutboxKinds]: (input: OutboxKinds[K]) => OutboxRouting
} = {
  // THE CHAT PARTITION (POD-4762): one per session, shared by both sends, so
  // the operator's messages reach the agent in the order they were written. It
  // is NOT the session's curation partition below: a parked rename (a share
  // revoked, say) would otherwise hold every later message to that session
  // until it aged out, and a chat send has no ordering to keep with a rename.
  sendText: (i) => ({ partitionKey: `chat:${i.sessionId}` }),
  resumeAndSend: (i) => ({ partitionKey: `chat:${i.sessionId}` }),

  // Session-targeted writes. All share the session's partition, so their order
  // relative to one another is preserved.
  // The offer cell, which holds AT MOST ONE offer per session — a new offer
  // replaces the standing one rather than joining it (the annotation matrix's
  // `offers` row: "single-row-per-session key"). So two queued dismissals for one
  // session cannot both be live decisions: the second names the offer that
  // replaced the first's target, and the first would meet the server's stamp
  // guard as a no-op. Collapsing to the newest sends the operator's last word and
  // drops a round trip that was going to be refused anyway.
  //
  // The key deliberately omits `offerCreatedAt`. Keyed by stamp nothing would
  // ever collapse — every dismissal names a different offer — which is a
  // collapse rule that does not collapse, i.e. a lie about the cell.
  dismissOffer: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-offer:${i.sessionId}`,
  }),

  // The curation writes (POD-781) share the issue's partition with the per-user
  // record edits (POD-6404), so a rename cannot overtake the delete that follows
  // it.
  //
  // `issueUpdate` gets NO COLLAPSE, for the reason `layoutSet` gets none: it is a PARTIAL patch. Two updates to one
  // issue are usually two different fields — title then priority — and
  // collapsing them on the row id would drop the rename. There is no cell to key
  // on, because the kind does not name a cell; it names a patch.
  issueUpdate: (i) => ({ partitionKey: `issue:${i.id}` }),
  // Archive and delete DO name a cell each, and each is one-way: a second
  // archive of an already-archived issue, or a second delete of an already-
  // tombstoned one, adds nothing the first did not do. Newest wins, which is the
  // same thing the user's second click meant. Deliberately NOT shared with
  // `issueUpdate{archived}` — the un-archive path goes through the patch kind,
  // which collapses with nothing, so nothing can silently drop it.
  issueDelete: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-deleted:${i.id}`,
  }),

  // POD-781 group 2. Each of these names ONE cell, absolutely — the second write
  // says everything the first did — so each collapses, and the pairs that write
  // the SAME cell share a key, exactly as `snoozeSet`/`snoozeClear` do.
  //
  // `issueClose` keys on the closed cell. A close and a re-close differ only in
  // reason and the newest reason is the one the operator meant. It does NOT share
  // with `issueUpdate{stage}`: the patch kind collapses with nothing, so a reopen
  // queued behind a close can never be dropped.
  issueClose: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-closed:${i.id}`,
  }),

  // POD-781 group 3.
  //
  // THE COLLAPSE KEY CARRIES THE ORIGIN, which no other kind here needs to do.
  // A placement is absolute — "part of the mission" or "its own thing" — but only
  // RELATIVE TO ONE ORIGIN, and the command writes an edge naming that origin.
  // Keyed on the issue alone, "own w.r.t. A" then "mission w.r.t. B" would
  // collapse to the second, and A's discovered-from edge — the whole point of the
  // first decision — would never be written. Two decisions about the SAME origin
  // do subsume each other, and those still collapse.
  issueSetPlacement: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-placement:${i.id}:${i.originId}`,
  }),
  // RESTORE SHARES `issue-deleted` WITH DELETE, which is `snoozeSet`/`snoozeClear`'s
  // arrangement and is chosen for the same reason: both write the one `deletedAt`
  // cell, so "delete — no, undo" must send the operator's LAST word rather than
  // both words in order. Collapsing the pair away is strictly better than sending
  // it: the delete that never leaves is a cascade that never kills the member
  // sessions' PTYs, and the restore the operator meant is where the row ends up
  // either way. (Only PENDING entries collapse — a delete already drained is
  // beyond this and the restore follows it down the same partition, in order.)
  issueRestore: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-deleted:${i.id}`,
  }),

  // GENERIC RECORD WRITES (POD-6392) share the partition of the pool row they
  // land on, so a generic edit keeps its order with the per-command writes to
  // the same issue or session. A create or a remove is one act each and never
  // collapses. An edit collapses only into a later one that sets or clears
  // EXACTLY the same cells of the same record and names no revision (POD-6404):
  // that later edit subsumes it, so "mark read, mark unread" or "snooze, clear
  // the snooze" sends the last word, as the per-command kinds did. A partial
  // patch of other cells, or a revision-checked edit, never collapses.
  recordCreate: (i) => ({ partitionKey: recordPartition(i) }),
  recordEdit: (i) => {
    const collapseKey = recordEditCollapseKey(i)
    return collapseKey === undefined
      ? { partitionKey: recordPartition(i) }
      : { partitionKey: recordPartition(i), collapseKey }
  },
  recordRemove: (i) => ({ partitionKey: recordPartition(i) }),
  // An effect on a record queues behind that record's own writes (a start
  // behind nothing; a dismiss behind its create).
  effectCreate: (i) => ({ partitionKey: `effect:${i.id}` }),
  effectDismiss: (i) => ({ partitionKey: `effect:${i.id}` }),
}

/** The cells one revision-free record edit writes, as a collapse key. */
function recordEditCollapseKey(input: RecordOutboxInputs['recordEdit']): string | undefined {
  if (input.expectedRevision !== undefined) return undefined
  const cells = [
    ...Object.keys(input.patch).filter((name) => input.patch[name] !== undefined),
    ...(input.unset ?? []),
  ].sort()
  return cells.length === 0 ? undefined : `record:${input.kind}:${input.id}:${cells.join(',')}`
}

/** The ordering domain of one record: its pool row's. Layout keys keep the
 *  one `layout` partition `layout.set` always had. */
function recordPartition(input: { kind: RecordKind; id: string }): string {
  const home = RECORD_HOMES[input.kind]
  if (home === null) return 'layout'
  const row = home.row(input.id)
  // My pins, tab orders and preferences (POD-6673): one partition per record,
  // so they never wait behind a session's or an issue's writes.
  if (home.target === 'pins') return `pin:${row}`
  if (home.target === 'tabOrders') return `tabs:${row}`
  if (home.target === 'userPreferences') return 'preferences'
  if (home.target === 'userReadPositions') return `read:${row}`
  // An effect record's decision queues with that record's other writes.
  if (home.target === 'effects') return `effect:${row}`
  if (home.target === 'superagentThreads') return `thread:${row}`
  // A subscription's writes queue with that subscription's other writes.
  if (home.target === 'subscriptions') return `subscription:${row}`
  // A session's own record and its per-user row order with the session's other
  // writes (an offer dismissal), as the per-command kinds did.
  return home.target === 'sessionUserStates' || home.target === 'sessions'
    ? `session:${row}`
    : `issue:${row}`
}

/** Route one queued write. Falls back to the entry's own private partition — D12's
 *  rule for a command with no resolvable target — rather than to a shared one, so
 *  an unknown kind can never reinstate the global wedge. */
export const outboxRoutingFor = <K extends keyof OutboxKinds & string>(
  kind: K,
  input: OutboxKinds[K],
  mutationId: MutationId,
): OutboxRouting => {
  const route = OUTBOX_ROUTING[kind] as ((i: OutboxKinds[K]) => OutboxRouting) | undefined
  return route ? route(input) : { partitionKey: `create:${mutationId}` }
}

/**
 * HOW LONG A CHAT SEND KEEPS TRYING (POD-4762): two minutes from the press.
 *
 * The user decided it (2026-09-28): a message that cannot reach the server
 * fails VISIBLY — "not sent — retry" — instead of arriving hours late into a
 * conversation that has moved on. Two minutes rides out what a person sitting
 * at the composer lives through without noticing: a Wi-Fi hand-off, a laptop
 * waking, a server restart, the backoff's first seven attempts (1 s doubling to
 * the 60 s cap). Past that, a person is better served by being told than by
 * waiting on a spinner. The retry the bubble then offers keeps the message id
 * (the kernel's same-id re-issue), so a send whose answer — not whose request —
 * was lost comes back as the one message the server already has.
 *
 * Offline queueing (send now, deliver whenever the phone is back) is a later
 * change of THIS number, not a redesign. D10 lets a per-command age only
 * shorten the 14-day base, and the kernel refuses anything longer at open.
 */
export const CHAT_SEND_MAX_AGE_MS = 2 * 60 * 1000

/** D10's per-command overrides, keyed by contract name — what the kernel queue
 *  takes as `commandMaxAgeMs`. Only the chat sends shorten theirs. */
export const OUTBOX_COMMAND_MAX_AGE_MS: Readonly<Record<string, number>> = {
  [OUTBOX_COMMANDS.sendText.name]: CHAT_SEND_MAX_AGE_MS,
  [OUTBOX_COMMANDS.resumeAndSend.name]: CHAT_SEND_MAX_AGE_MS,
}

/** The contract behind one queued entry, or `undefined` for a kind with no
 *  executor. A record kind's contract depends on its input's record kind, so
 *  without the input it has none. */
export const outboxCommandFor = (
  kind: string,
  input?: unknown,
): (OutboxCommand & { confirmation: ConfirmationRule }) | undefined => {
  if (isRecordOutboxKind(kind)) {
    const recordKind = (input as { kind?: unknown } | undefined)?.kind
    if (typeof recordKind !== 'string') return undefined
    const d = recordDeclaration(recordKind)
    const op = d?.ops[recordOpOf(kind)]
    if (d === undefined || op === undefined) return undefined
    return {
      name: recordWireCommand(kind, d.kind),
      version: 1,
      delivery,
      confirmation: op.policy.confirmation,
    }
  }
  if (isLegacyOutboxKind(kind)) {
    return { ...LEGACY_OUTBOX_COMMANDS[kind], delivery, confirmation: 'none' }
  }
  return OUTBOX_COMMANDS[kind as FixedOutboxKind]
}

/** The contract one queued write is sent under. Total over the kinds. */
export function outboxCommandOf<K extends keyof OutboxKinds & string>(
  kind: K,
  input: OutboxKinds[K],
): OutboxCommand & { confirmation: ConfirmationRule } {
  const command = outboxCommandFor(kind, input)
  if (command === undefined) throw new Error(`no command for a queued ${kind}`)
  return command
}

/**
 * An older server: it has no `sync.submit`, so tRPC answers `NOT_FOUND` naming the
 * path. Only that answer. `sync.submit` itself never throws `NOT_FOUND` — a missing
 * target is a `rejected` reply — but `classifyRefusal` reads any 404 as a definitive
 * refusal, and a write dead-lettered for want of a route is the one outcome the
 * fixed kinds must never produce. One test for the queued and the immediate writes
 * (`submitNow`, POD-6412), so the two cannot disagree about an old server.
 */
export { isMissingSyncSubmit }

type WithMutationId = { readonly mutationId: MutationId }

/**
 * Send one effect command on `sync.submit` (POD-6408), for the queues that call
 * an executor. Like a record write it exists only there: a server without the
 * entry point cannot take it, which is a definitive refusal.
 */
async function submitEffect(
  api: PodiumClientApi,
  name: 'effects.create' | 'effects.dismiss',
  input: { readonly mutationId: MutationId },
): Promise<unknown> {
  const { mutationId, ...wire } = input as { mutationId: MutationId } & Record<string, unknown>
  const submit = api.sync?.submit
  if (submit === undefined) {
    throw Object.assign(new Error(`this server does not serve ${name}`), {
      data: { code: 'BAD_REQUEST' },
    })
  }
  const raw = await submit.mutate({ mutationId, command: name, version: 1, input: wire })
  const reply = SyncSubmitReply.parse(raw)
  if (reply.outcome === 'rejected') {
    throw new SyncSubmitRefusedError(name, reply.refusal)
  }
  return reply.result
}

/**
 * Send one record write on `sync.submit`, for the queues that call an executor
 * (the compatibility queue, and the kernel queue's per-kind fallback). A record
 * command exists ONLY on `sync.submit`: there is no per-command route to fall
 * back to. A server without the entry point cannot serve it at all, so that is a
 * definitive refusal (it snaps back and says it could not save) rather than a
 * retry that would paint a write no server of this version will ever take.
 */
async function submitRecord(
  api: PodiumClientApi,
  kind: RecordOutboxKind,
  input: RecordOutboxInputs[RecordOutboxKind] & { mutationId: MutationId },
  hooks: OutboxExecutorHooks = {},
): Promise<unknown> {
  const { mutationId, ...entry } = input
  const command = outboxCommandFor(kind, entry)
  if (command === undefined) throw new Error(`no command for a queued ${kind} of ${entry.kind}`)
  const unserved = () =>
    Object.assign(new Error(`this server does not serve ${command.name}`), {
      data: { code: 'BAD_REQUEST' },
    })
  /** A server without the entry point: the edit's old route(s), else refused. */
  const legacy = async (): Promise<unknown> => {
    const answer =
      kind === 'recordEdit'
        ? await submitRecordEditAsLegacy(api, { ...(entry as RecordEditEntry), mutationId })
        : kind === 'recordRemove'
          ? await submitRecordRemoveAsLegacy(api, { ...(entry as RecordRemoveEntry), mutationId })
          : undefined
    if (answer === undefined) throw unserved()
    return answer
  }
  const submit = api.sync?.submit
  if (submit === undefined || hooks.syncSubmitMissing === true) return await legacy()
  // This device's own chain of edits on the record (POD-6403).
  const chain = recordRevisionChainFor(api)
  const against = chain.sendAgainst(kind, entry)
  const wire = recordWireInput(entry)
  let raw: unknown
  try {
    raw = await submit.mutate({
      mutationId,
      command: command.name,
      version: command.version,
      input: against === undefined ? wire : { ...wire, expectedRevision: against },
    })
  } catch (error) {
    if (isMissingSyncSubmit(error)) return await legacy()
    throw error
  }
  const reply = SyncSubmitReply.parse(raw)
  if (reply.outcome === 'applied') {
    chain.applied(kind, entry, reply.result)
    return reply.result
  }
  throw new SyncSubmitRefusedError(command.name, reply.refusal)
}

/** SocketHub construction seam — injectable so engine unit tests run a fake hub. */
export type CreateHub = (opts: ConstructorParameters<typeof SocketHub>[0]) => SocketHub

/** Expected cold-offline failures leave the persisted kernel slice mounted. */
export function isInitialConnectivityError(message: string): boolean {
  return (
    message === 'WebSocket connection failed' ||
    message === 'WebSocket connection closed before connecting'
  )
}

export function createEngineHub(args: {
  wsClientUrl: string
  api: PodiumClientApi
  replica: Replica
  onFatalError: (message: string) => void
  createHub?: CreateHub
  /**
   * WIRE v2 (POD-1223): when supplied, this hub advertises wire 2 and hands
   * every frame to the kernel Replica's consumer.
   *
   * The two feed ports are mutually exclusive. Canonical v2 envelopes go to
   * the supplied Replica sink; wire-v1 gets a Replica-owned compatibility sink.
   */
  feed?: FeedSinkPort
  /** Liveness ping cadence, when the platform has an opinion (native: 10 s). */
  heartbeatIntervalMs?: number
  makeSocket?: import('../socket-transport').SocketHubOptions['makeSocket']
}): SocketHub {
  const { api, replica } = args
  const make: CreateHub = args.createHub ?? ((opts) => new SocketHub(opts))
  const heartbeat =
    args.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: args.heartbeatIntervalMs }
      : undefined
  if (args.feed !== undefined) {
    return make({
      url: args.wsClientUrl,
      onError: (message) => {
        if (!isInitialConnectivityError(message)) args.onFatalError(message)
      },
      feed: args.feed,
      ...(args.makeSocket ? { makeSocket: args.makeSocket } : {}),
      ...heartbeat,
    })
  }
  return make({
    url: args.wsClientUrl,
    onError: (message) => args.onFatalError(message),
    ...heartbeat,
    issuesNormalized: true,
    ...(args.makeSocket ? { makeSocket: args.makeSocket } : {}),
    legacyFeed: new LegacyWireV1Feed({
      fetchChangesSince: (cursor) => api.sync.changesSince.query({ cursor }),
      initialCursor: replica.getCursor(),
      applied: (state) => applyLegacyMetadataState(replica, state),
    }),
  })
}

/** What an executor reports that is neither applied nor refused. */
export interface OutboxExecutorHooks {
  /** A send resolved without delivery because its session no longer exists. */
  readonly sessionGone?: (input: OutboxKinds['resumeAndSend']) => void
  /**
   * A send resolved undelivered because a Stop reached the server first
   * (POD-4654). The kernel retires the entry in the verdict's own commit
   * (POD-4690); this hook only reports the reading, like `sessionGone`.
   */
  readonly stoppedSend?: () => void
  /**
   * The queue already found this server without `sync.submit` (POD-6277's
   * detection): a record write goes straight to its legacy route rather than
   * probing the entry point a second time.
   */
  readonly syncSubmitMissing?: boolean
}

/**
 * Read one chat send's reply. Both sends answer alike, so both read it here.
 */
function settleSend(
  result: unknown,
  input: OutboxKinds['sendText' | 'resumeAndSend'],
  hooks: OutboxExecutorHooks,
): unknown {
  // A Stop that reached the server first retracted this send (POD-4654): the
  // stop took effect, so the entry is done. Parked, it would hold every later
  // message to the session behind it for good.
  if (isStoppedSend(result)) {
    hooks.stoppedSend?.()
    return result
  }
  // The session was deleted before this send arrived (POD-4660). No session
  // is left to deliver it to and a retry gets the same answer, so the entry
  // is done — the operator is told it was not sent instead.
  if (isUnaddressableSend(result)) {
    hooks.sessionGone?.({ sessionId: input.sessionId, text: input.text })
    return result
  }
  // dead_letter / refused is HTTP 200 with ok:false — must not be applied
  assertSendAccepted(result)
  return result
}

/**
 * Read one queued command's result, as its kind reads it (POD-6277).
 *
 * The same reading whichever route carried the command: the old per-command
 * procedure returns the result itself, and `sync.submit` returns it as its
 * reply's `result`. Only the chat sends read theirs; every other kind's result
 * is the answer as it stands. Throws as the executor would for a send the
 * server refused in its reply (`ok: false`).
 */
export function readOutboxReply<K extends keyof OutboxKinds>(
  kind: K,
  input: OutboxKinds[K],
  result: unknown,
  hooks: OutboxExecutorHooks = {},
): unknown {
  if (kind === 'sendText' || kind === 'resumeAndSend') {
    return settleSend(result, input as OutboxKinds['sendText' | 'resumeAndSend'], hooks)
  }
  return result
}

/**
 * THE ONE PLACE A QUEUED KIND MEETS ITS PROCEDURE, and it is one place because
 * POD-781 group 3 found out what two places cost.
 *
 * This map used to live inline in `createEngineOutbox` below, and the
 * kernel-backed queue (`engine/kernel-outbox.ts`, which is what the WEB app
 * actually runs) carried a hand-written `switch` over dotted command names
 * doing the same job. The two drifted the moment this issue added a kind: seven
 * curation commands were queued, routed, overlaid and tested, and every one of
 * them hit the switch's `default` arm — a synthetic BAD_REQUEST, classified as a
 * definitive refusal. So the row painted on the press, dead-lettered, and
 * snapped back a beat later. Nothing failed loudly enough to notice in a unit
 * test, because the unit tests exercised THIS map.
 *
 * A `{ [K in keyof OutboxKinds]: … }` mapped type is total by construction: a new
 * kind fails to compile here rather than failing at runtime on a user's drop.
 * Both queues read it.
 */
export function outboxExecutors(
  api: PodiumClientApi,
  hooks: OutboxExecutorHooks = {},
): {
  [K in keyof OutboxKinds]: (input: OutboxKinds[K]) => Promise<unknown>
} & Record<LegacyOutboxKind, (input: Record<string, unknown>) => Promise<unknown>> {
  return {
    sendText: async (i) =>
      readOutboxReply('sendText', i, await api.sessions.sendText.mutate(i), hooks),
    resumeAndSend: async (i) =>
      readOutboxReply('resumeAndSend', i, await api.sessions.resumeAndSend.mutate(i), hooks),
    // On the sync write entry point (POD-6415), under the entry's own id.
    // LEGACY(remove-after: 2027-03): a server without `sync.submit` (or this
    // command on it) takes the old route.
    dismissOffer: (i) => {
      const legacy = async () => await api.sessions.dismissOffer.mutate(i)
      if (hooks.syncSubmitMissing === true) return legacy()
      return submitNow(
        api,
        'sessions.dismissOffer',
        { sessionId: i.sessionId, offerCreatedAt: i.offerCreatedAt },
        { mutationId: (i as typeof i & WithMutationId).mutationId, legacy },
      )
    },
    issueUpdate: (i) => api.issues.update.mutate(i),
    issueDelete: (i) => api.issues.delete.mutate(i),
    issueClose: (i) => api.issues.close.mutate(i),
    issueSetPlacement: (i) => api.issues.setPlacement.mutate(i),
    issueRestore: (i) => api.issues.restore.mutate(i),
    // Both queues hand an executor the entry's input WITH its mutationId
    // (`OutboxExecutors`); a record write needs it for its own submit.
    recordCreate: (i) => submitRecord(api, 'recordCreate', i as typeof i & WithMutationId, hooks),
    recordEdit: (i) => submitRecord(api, 'recordEdit', i as typeof i & WithMutationId, hooks),
    recordRemove: (i) => submitRecord(api, 'recordRemove', i as typeof i & WithMutationId, hooks),
    effectCreate: (i) => submitEffect(api, 'effects.create', i as typeof i & WithMutationId),
    effectDismiss: (i) => submitEffect(api, 'effects.dismiss', i as typeof i & WithMutationId),
    // LEGACY(remove-after: 2027-03): entries an older build queued under the
    // retired plain-edit kinds drain under their old routes.
    ...legacyOutboxExecutors(api),
  }
}

/** Durable write path for the covered mutations. PoolTransactions paints each
 *  pending entry over the replica's server truth, so an
 *  offline write both survives a reload AND keeps painting after it, then
 *  replays (deduped by mutationId) on reconnect. */
export function createEngineOutbox(args: EngineOutboxCallbacks): Outbox<OutboxKinds> {
  const { api } = args
  return new Outbox<OutboxKinds>({
    isOnline: args.isOnline ?? platformIsOnline,
    onlineEvents: args.onlineEvents ?? platformOnlineEvents(),
    // One persistence layer: the queue persists into a replica collection
    // (cross-tab consistent via storage events; in-memory in private mode);
    // the drain/retry/poison logic is unchanged. The awaiting-truth stage
    // lives in its OWN collection (#263 review round 2) so a downgraded build
    // reading the queued collection never re-drains held entries.
    storage: args.replica.outboxStorage(),
    awaitingStorage: args.replica.outboxAwaitingStorage(),
    deadLetterStorage: args.replica.outboxDeadLetterStorage(),
    shouldDiscardDeadLetter: (entry) => !shouldParkDeadLetter(entry.kind, entry.input),
    executors: outboxExecutors(api, {
      sessionGone: (input) => args.notices.error(sessionGoneNotice(input.text)),
    }),
    onApplied: args.onApplied,
    onSettled: args.onSettled,
    // A refused write with no typed words is reverted (overlay drops) and
    // toasted. Authored prose is parked so the words are not lost — a toast
    // that said they were gone would teach people to re-type instead of look.
    onPoison: (entry, error) => {
      const refusal = classifyRefusal(error)
      args.onDropped?.(entry, refusal === undefined ? undefined : normalizeRefusal(refusal))
      if (
        !shouldParkDeadLetter(entry.kind, entry.input) &&
        deadLetterHandlingFor(entry.kind, entry.input) !== 'discard-automatic'
      ) {
        args.notices.error(
          couldNotSaveNotice(
            entry.kind,
            entry.input,
            refusal === undefined ? undefined : normalizeRefusal(refusal),
          ),
        )
      }
    },
    onDeadLetter: (parked) => {
      args.notices.error(couldNotSaveNotice(parked.entry.kind, parked.entry.input, parked.reason))
      args.onDeadLetter?.(parked)
    },
  })
}
