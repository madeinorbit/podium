import {
  AgentProfileWire,
  AutomationRunWire,
  AutomationWire,
  CheckoutWire,
  ConversationRecordWire,
  EffectRecordWire,
  GlobalChangeOpField,
  InstancePreferencesWire,
  IssueBriefWire,
  IssueDepProjection,
  IssueDescriptionWire,
  IssueEventWire,
  IssueGitStateProjection,
  IssuePanelArtifactWire,
  IssuePanelDeferredWire,
  IssuePanelStateWire,
  IssuePanelTodoWire,
  IssueProjection,
  IssueUserStateWire,
  LayoutWire,
  MachineAccessWire,
  MachineProjection,
  MessageRecordWire,
  NoticeWire,
  PinWire,
  ReadPositionWire,
  RepoProjection,
  SessionMeta,
  SessionUserStateWire,
  SlimIssueProjection,
  SubscriptionWire,
  SuperagentThreadWire,
  TabOrderWire,
  UserPreferencesWire,
  WorkflowBindingWire,
  WorkflowRevisionWire,
  WorkflowRunRecord,
  WorkflowWire,
} from '@podium/model'
import { ShipLaneProjection, ShipOrderProjection } from '@podium/model/shipping-projection'
import { z } from 'zod'
import { changeRowArm } from './change-row'
import { PendingInteractionWire } from './runtime-interactions'

/**
 * Re-exported from `@podium/model` [POD-796, POD-822].
 *
 * Each of these is an arm of {@link MetadataChange}, so each IS a wire shape,
 * and a peer that parses the feed must be able to name it without taking a
 * dependency this layer does not permit it: `@podium/terminal-client` depends on
 * protocol ONLY (ADR 8; protocol is the one near-leaf allowed to import model —
 * see RESTRICTED_PACKAGE_DEPS in scripts/check-boundaries.ts). Re-exporting here
 * keeps the vocabulary single-sourced in model while letting protocol's
 * consumers stay on protocol.
 */
export {
  IssueDepProjection,
  IssueEventWire,
  IssueGitStateProjection,
  IssueProjection,
  IssueUserStateWire,
  MachineProjection,
  RepoProjection,
  SessionUserStateWire,
  ShipLaneProjection,
  ShipOrderProjection,
}

// ---- Metadata oplog (docs/spec/oplog-read-path.md) ----
// One row of the server's metadata change log. `seq` is server-assigned and
// globally monotonic across all entities (one stream, one cursor). `value` is the
// entity's WIRE shape — the oplog speaks protocol, not DB rows. Present iff
// op === 'upsert' (zod can't express that cross-field rule; producers guarantee it,
// consumers treat a missing value on upsert as a drop-this-change).
/**
 * The op vocabulary a GLOBAL change row may carry — `@podium/model`'s, not a
 * second copy (POD-305). `evict` is deliberately not a member: it is a
 * per-principal fact and never a row in the one global log (ADR 2 Am1 D14.5).
 */
export const MetadataChangeOp = GlobalChangeOpField
export type MetadataChangeOp = z.infer<typeof MetadataChangeOp>

/**
 * ONE arm of the change union (POD-305).
 *
 * The five arms below used to restate `seq`/`entity`/`id`/`op`/`value` verbatim,
 * and so did `UnknownMetadataChange` — six copies of one field list, which is the
 * restatement POD-305's acceptance criterion 3 and the `change-row-typings` audit
 * item target. The FIELDS now come from `@podium/model`'s change vocabulary and
 * the ARM SHAPE is composed here exactly once.
 *
 * Key ORDER is preserved exactly as it was (`seq`, `entity`, `id`, `op`, `value`):
 * zod emits parsed keys in shape order, so a reordering here would change the
 * serialization of every change row on the wire — a silent break in a refactor
 * that is supposed to have none. `wire-golden.json` is the gate on that.
 *
 * `value` is present iff `op === 'upsert'`. Zod cannot express that cross-field
 * rule; producers guarantee it and consumers treat a missing value on an upsert as
 * a drop-this-change.
 */
const metadataChangeArm = <E extends z.ZodTypeAny, V extends z.ZodTypeAny>(entity: E, value: V) =>
  changeRowArm('id', entity, MetadataChangeOp, value)

// ---- Feed identity (ADR 2 D1) ----
//
// A cursor is meaningless without it. `seq` alone cannot distinguish "you are
// up to date" from "you hold entities off a timeline that no longer exists":
// restore the authority from a backup whose log ends at 400 while a client
// holds 500, let the authority write 100 more changes, and `changesSince(500)`
// finds cursor === max and answers `[]` — "up to date" — forever. The client's
// 401..500 are phantoms from the dead timeline and nothing can ever detect it.
// A replica's cursor is therefore the TRIPLE (feedId, epoch, seq); any mismatch
// on either id is a RESET (re-bootstrap), never a heal.
//
// Both ids are OPAQUE and compared by EQUALITY ONLY. The epoch is a minted,
// never-reused id — deliberately NOT a counter. The epoch lives in the database,
// so restoring a backup restores the OLD epoch with the old seqs and the bump
// must happen at restore time on the restored value: restore `epoch=3` → bump →
// 4; restore THE SAME backup again → 3 again → bump → 4 AGAIN, a different
// timeline wearing an epoch clients already accepted. A counter silently
// re-collides in exactly the situation the epoch exists to catch. Ordering is
// never needed — a replica only asks "is this the generation I hold?".
const FeedIdShape = {
  /** Stable identity of the feed — minted once per authority database. Changes
   *  ONLY when the database is genuinely a different feed. This is also the
   *  federation seam's authority/feed identity [spec:SP-0371]. */
  feedId: z.string().min(1).optional(),
  /** Identity of the current seq-continuity generation. The authority mints a
   *  NEW one whenever it cannot guarantee its seqs continue the ones clients
   *  hold: restore from backup, DB rebuild, any operator action that rewinds
   *  `changes`.
   *
   *  NOT `SessionMeta.epoch`, which is an unrelated per-session PTY generation
   *  counter living inside a change's `value`. This one identifies the FEED and
   *  is a string precisely because it is never counted or ordered. The two never
   *  meet — different scopes, different types — but they read alike at a glance,
   *  so: this is the feed's, that one is a session's. */
  epoch: z.string().min(1).optional(),
  /** The lowest seq the authority can still DELIVER (ADR 2 D5) — the retention
   *  horizon, published so a replica can tell it must re-bootstrap BEFORE
   *  asking rather than after being refused.
   *
   *  Exactly: `minChangeSeq() ?? maxChangeSeq() + 1`. The fallback is what makes
   *  the number total — a fully-pruned log can deliver nothing that exists, and
   *  the next change it writes will be max + 1, which is true and precise.
   *  Always >= 1 (seqs are 1-based).
   *
   *  The precise replica predicate is `cursor + 1 < minAvailableSeq` ⇒
   *  re-bootstrap, which is the authority's own servability rule: it can serve
   *  a cursor iff every change in (cursor, max] is retained, i.e. iff
   *  cursor + 1 >= minAvailableSeq. (ADR 2 D7 rung 2 states the shorthand
   *  `cursor < minAvailableSeq`; that is the same rule off by one, and errs
   *  toward one needless re-bootstrap — safe, since the authority's answer is
   *  the authority either way, but the exact form is free.) */
  minAvailableSeq: z.number().int().positive().optional(),
} as const

export const MetadataChange = z.discriminatedUnion('entity', [
  metadataChangeArm(z.literal('session'), SessionMeta),

  /** The issue record without its body fields (`brief`, `panel`,
   *  `description`, `activityNotes`): the brief and description are the
   *  `issueBrief` and `issueDescription` records below, the panel and notes
   *  the panel records (POD-6921). */
  metadataChangeArm(z.literal('issueProjection'), SlimIssueProjection),
  /** An issue dependency EDGE [POD-822, ADR 4 D7.1] — `issue_deps` rows as
   *  first-class entities, keyed by their own primary key (`issueDepId`).
   *
   *  The relation the feed never carried. `IssueProjection` cannot hold `deps`
   *  without re-acquiring the cross-entity coupling it exists to shed (an edge
   *  belongs to two issues; see model's `fields/issue-dep.ts`), so the edge is
   *  its own kind and the replica joins it. That is what makes `depAdd` cost
   *  O(1) server-side and still move `blocked` on both endpoints.
   *
   *  Same additive contract as issueProjection: emitted unconditionally and
   *  invisible to a build whose `MetadataEntityKind` predates it — those rows
   *  fall to {@link UnknownMetadataChange}, are ignored, and the cursor advances.
   *  `CLIENT_WIRE_VERSION` stays 1 (ADR 2 D4). */
  metadataChangeArm(z.literal('issueDep'), IssueDepProjection),
  /** A logical repo [POD-822] — today just `(repoId, prefix)`, the join input
   *  for `displayRef`.
   *
   *  `prefix` is a function of the REPO, so materializing it onto every issue
   *  would make a prefix change rewrite every issue in the repo on the write
   *  path (D7.2). One repo row instead; the replica joins `issue.repoId →
   *  repo.prefix` and every `POD-13` in the repo moves at once. Same additive
   *  contract as the two kinds above. */
  metadataChangeArm(z.literal('repo'), RepoProjection),
  metadataChangeArm(z.literal('shipOrder'), ShipOrderProjection),
  /** One delivery lane's queue in the scheduler's order (POD-4974 O2, ADR 4
   *  D7.4), keyed by `shipLaneId(repoId, canonical destination)`. The server
   *  recomputes it only for the lanes a shipping commit touches, so a ship order
   *  no longer needs every order ever stored to know its rank. Same additive
   *  contract as the kinds above: an older build parses these rows as
   *  {@link UnknownMetadataChange}, ignores them and advances its cursor.
   *  `CLIENT_WIRE_VERSION` stays 1 (ADR 2 D4). */
  metadataChangeArm(z.literal('shipLane'), ShipLaneProjection),
  metadataChangeArm(z.literal('conversation'), ConversationRecordWire),
  metadataChangeArm(z.literal('automation'), AutomationWire),
  metadataChangeArm(z.literal('automationRun'), AutomationRunWire),
  /** Per-user sidebar/tab layout row (POD-1350) — keyed `(userId, key)` on the
   *  change id via `layoutRowId`. Visibility class `per-user-state`: only the
   *  owning human's principals see the row (ADR 9 D3 rule 4). Additive on the
   *  wire (same contract as issueProjection): older clients ignore via
   *  UnknownMetadataChange and advance the cursor. */
  metadataChangeArm(z.literal('userLayout'), LayoutWire),
  /** Per-user event-stream read position (POD-1380) — keyed `(userId, feedId)` on
   *  the change id via `readPositionRowId`. Visibility class `per-user-state`, the
   *  same as `userLayout` and for a sharper reason: a read cursor delivered to
   *  the wrong principal is a privacy defect that looks exactly like a working
   *  cursor. Additive on the wire; older clients ignore it via
   *  UnknownMetadataChange and advance the cursor. */
  metadataChangeArm(z.literal('userReadPosition'), ReadPositionWire),
  /** One curated issue event (POD-1772) — `podium_events` rows as first-class
   *  entities, keyed by `issueEventRowId(eventId, subject)`.
   *
   *  The chat feed's content, moved off a 15 s RPC timer and onto the one data
   *  path the rest of the app uses. Visibility class `personal`, decided by the
   *  SUBJECT issue: an event is readable by whoever may read the issue it is
   *  about, which is why the subject rides the row id.
   *
   *  The log is unbounded and the replica is not, so the publisher holds a
   *  bounded WINDOW: an event entering the window is an upsert, an event leaving
   *  it is a `delete`. Bootstrap therefore carries a capped tail, not the whole
   *  history of the installation.
   *
   *  Same additive contract as the kinds above: emitted unconditionally and
   *  invisible to a build whose `MetadataEntityKind` predates it — those rows
   *  fall to {@link UnknownMetadataChange}, are ignored, and the cursor advances.
   *  `CLIENT_WIRE_VERSION` stays 1 (ADR 2 D4). */
  metadataChangeArm(z.literal('issueEvent'), IssueEventWire),
  /** One blocking ask (POD-2020, spec §4) — the PendingInteraction aggregate on
   *  the feed, so "answering from any surface resolves it everywhere" is a
   *  property of the data path rather than of four clients agreeing.
   *
   *  Keyed by `interactionRowId(sessionId, id)`: the SUBJECT SESSION rides the
   *  change id, the same device `issueEvent` uses and for the same two reasons —
   *  `mayRead` answers from the id alone (no read of a row that a `delete` has
   *  already removed), and a bootstrap prefetches every subject session in one
   *  batched read instead of one `SELECT` per ask.
   *
   *  Its wire type is the ONE arm here that does not come from `@podium/model`:
   *  `PendingInteractionWire` is the agent-runtime contract's `PendingInteraction`
   *  plus the server aggregate's lifecycle, and it lives beside the contract type
   *  it extends rather than being half-restated up here. See `./runtime.ts`.
   *
   *  Same additive contract as the kinds above: emitted unconditionally and
   *  invisible to a build whose `MetadataEntityKind` predates it — those rows
   *  fall to {@link UnknownMetadataChange}, are ignored, and the cursor advances.
   *  `CLIENT_WIRE_VERSION` stays 1 (ADR 2 D4). */
  metadataChangeArm(z.literal('pendingInteraction'), PendingInteractionWire),
  /** A chat message a person sent into a session (POD-4764) — its record and
   *  delivery status, so every device shows the same status by id and the chat
   *  matches it to the agent's history by the entry id the machine named,
   *  never by text.
   *
   *  Keyed by `messageRecordRowId(sessionId, senderUserId, id)`: both people who
   *  may read it ride the change id, the same device `pendingInteraction` uses,
   *  so `mayRead` answers from the id alone and a bootstrap prefetches every
   *  subject session in one batched read.
   *
   *  The feed carries messages on their way, failed or lost-track ones until the
   *  sender dismisses them, and a bounded window of recently confirmed ones;
   *  the transcript is the history. Same additive contract as the kinds above:
   *  an older build parses these rows as {@link UnknownMetadataChange}, ignores
   *  them and advances its cursor. `CLIENT_WIRE_VERSION` stays 1 (ADR 2 D4). */
  metadataChangeArm(z.literal('message'), MessageRecordWire),
  metadataChangeArm(z.literal('issueUserState'), IssueUserStateWire),
  metadataChangeArm(z.literal('sessionUserState'), SessionUserStateWire),
  metadataChangeArm(z.literal('machine'), MachineProjection),
  metadataChangeArm(z.literal('issueGitState'), IssueGitStateProjection),
  /** A one-shot effect and its standard status (ADR 12 D5 E2, POD-6357): merge,
   *  file write, scans, clone, interrupt. Visibility class `personal`: readable by
   *  whoever created it and by the readers of its target. Additive: an older
   *  build parses these rows as {@link UnknownMetadataChange} and advances. */
  metadataChangeArm(z.literal('effect'), EffectRecordWire),
  /** Per-user records (POD-6673, ADR 12 D1): a pin (keyed `pinRowId`), a
   *  worktree's tab order (`tabOrderRowId`) and one person's personal
   *  preferences (`userPreferencesRowId`). Visibility class `per-user-state`:
   *  the owner's principals only. Additive: an older build parses these rows as
   *  {@link UnknownMetadataChange} and advances. */
  metadataChangeArm(z.literal('pin'), PinWire),
  metadataChangeArm(z.literal('tabOrder'), TabOrderWire),
  metadataChangeArm(z.literal('userPreferences'), UserPreferencesWire),
  /** A superagent thread (POD-6675, ADR 12 D1), keyed `superagentThreadRowId`.
   *  Visibility class `per-user-state`: its owner's principals only. Additive:
   *  an older build parses these rows as {@link UnknownMetadataChange}. */
  metadataChangeArm(z.literal('superagentThread'), SuperagentThreadWire),
  /** Agent profiles, workflows and automation trigger subscriptions
   *  (POD-6676, ADR 12 D1; design POD-5620 §1.9-1.11). A profile is instance
   *  substrate (every member); a workflow, its revisions, a binding and a run
   *  follow their owner; a subscription its subscriber (row id
   *  `subscriptionRowId`). A binding is keyed `workflowBindingRowId`. Additive:
   *  an older build parses these rows as {@link UnknownMetadataChange} and
   *  advances. */
  metadataChangeArm(z.literal('agentProfile'), AgentProfileWire),
  metadataChangeArm(z.literal('workflow'), WorkflowWire),
  metadataChangeArm(z.literal('workflowRevision'), WorkflowRevisionWire),
  metadataChangeArm(z.literal('workflowBinding'), WorkflowBindingWire),
  metadataChangeArm(z.literal('workflowRun'), WorkflowRunRecord),
  metadataChangeArm(z.literal('subscription'), SubscriptionWire),
  /** The instance preferences (POD-6677, ADR 12 D1): one record per instance,
   *  keyed `INSTANCE_PREFERENCES_ROW_ID`, whose fields are the instance tier's
   *  leaf paths. Visibility class `deployment-substrate`: every member reads it.
   *  Never a secret. Additive: an older build parses these rows as
   *  {@link UnknownMetadataChange} and advances. */
  metadataChangeArm(z.literal('instancePreferences'), InstancePreferencesWire),
  /** A machine's synced records beside `machine` (POD-6644, design POD-5620
   *  §1.12): one member's access row for one machine (`machineAccessRowId`,
   *  class `per-user-state`), and one checkout on one machine (`checkoutRowId`:
   *  a registered root is readable with `manage` or `use` on the machine, a
   *  worktree only with `use`). Additive: an older build parses
   *  these rows as {@link UnknownMetadataChange} and advances. */
  metadataChangeArm(z.literal('machineAccess'), MachineAccessWire),
  metadataChangeArm(z.literal('checkout'), CheckoutWire),
  /** An issue's brief and description (POD-6921, design POD-6253 §2), each
   *  keyed by the issue id and holding the whole text; absent when the field
   *  has none. Readable by the issue's readers. */
  metadataChangeArm(z.literal('issueBrief'), IssueBriefWire),
  metadataChangeArm(z.literal('issueDescription'), IssueDescriptionWire),
  metadataChangeArm(z.literal('issuePanelTodo'), IssuePanelTodoWire),
  metadataChangeArm(z.literal('issuePanelArtifact'), IssuePanelArtifactWire),
  metadataChangeArm(z.literal('issuePanelDeferred'), IssuePanelDeferredWire),
  metadataChangeArm(z.literal('issuePanelState'), IssuePanelStateWire),
  /** One open notice in one person's inbox (POD-6881, credential management
   *  spec §13), keyed `noticeRowId` (recipient first). Class `per-user-state`:
   *  its recipient's principals only. A resolved notice is a `remove`.
   *  Additive: an older build parses these rows as {@link UnknownMetadataChange}
   *  and advances. */
  metadataChangeArm(z.literal('inboxNotice'), NoticeWire),
])
export type MetadataChange = z.infer<typeof MetadataChange>
export const MetadataEntityKind = z.enum([
  'session',
  'issueProjection',
  'issueDep',
  'repo',
  'shipOrder',
  'shipLane',
  'conversation',
  'automation',
  'automationRun',
  'userLayout',
  'userReadPosition',
  'issueEvent',
  'pendingInteraction',
  'message',
  'issueUserState',
  'sessionUserState',
  'machine',
  'issueGitState',
  'effect',
  'pin',
  'tabOrder',
  'userPreferences',
  'superagentThread',
  'agentProfile',
  'workflow',
  'workflowRevision',
  'workflowBinding',
  'workflowRun',
  'subscription',
  'instancePreferences',
  'machineAccess',
  'checkout',
  'issueBrief',
  'issueDescription',
  'issuePanelTodo',
  'issuePanelArtifact',
  'issuePanelDeferred',
  'issuePanelState',
  'inboxNotice',
])
export type MetadataEntityKind = z.infer<typeof MetadataEntityKind>

// ---- Kind-tolerant (lenient) consumer parsing ([spec:SP-3fe2] #258) ----
// Forward-compat prep for future entity kinds ('machine', 'settings', …):
// producers NEVER emit unknown kinds today — every SERVER-side schema stays
// strict — but consumers parse the change stream LENIENTLY, so a NEWER server
// can add a kind without quarantining OLDER clients. Under the strict
// discriminatedUnion an unknown-kind row fails parse; a quarantined delta
// element is an invisible cursor gap, so the client heals via changesSince —
// which returns the same unknown rows and loops forever. The lenient union
// lets those rows through with `value: unknown`; consumers apply the known
// kinds, IGNORE the unknown ones (with a debug log), and advance the cursor.

/** The catch-all arm: a change row whose entity kind this build doesn't know.
 *  Known kinds are EXCLUDED — a known-kind row with an invalid value must
 *  still fail parse (quarantine → heal), never sneak through the catch-all. */
export const UnknownMetadataChange = metadataChangeArm(
  // Not a `z.literal`, but the same POSITION in the same arm shape: an unknown
  // kind is a change row like any other, and composing it here is what stops the
  // catch-all from drifting away from the strict arms it has to stay parallel to.
  z.string().refine((e) => !MetadataEntityKind.options.includes(e as MetadataEntityKind), {
    message: 'known entity kinds must parse through the strict MetadataChange union',
  }),
  z.unknown(),
)
export type UnknownMetadataChange = z.infer<typeof UnknownMetadataChange>

export const MetadataChangeLenient = z.union([MetadataChange, UnknownMetadataChange])
export type MetadataChangeLenient = MetadataChange | UnknownMetadataChange

/** Narrow a leniently parsed change to the known union. `false` means "a newer
 *  server sent a kind this build doesn't know": ignore the row (NEVER fold it
 *  into some other entity's list) but still advance the cursor past it. */
export function isKnownMetadataChange(change: MetadataChangeLenient): change is MetadataChange {
  return MetadataEntityKind.options.includes(change.entity as MetadataEntityKind)
}

// A batch of oplog changes, sent only to clients that sent `caps: ['metadataDelta']`.
// A view-filtered producer includes `fromExclusive`: omitted rows inside that
// explicit global source range are authorized-hidden, not transport loss.
export const MetadataDeltaMessage = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
  fromExclusive: z.number().int().nonnegative().optional(),
  changes: z.array(MetadataChange),
  ...FeedIdShape,
})
export type MetadataDeltaMessage = z.infer<typeof MetadataDeltaMessage>

/** {@link MetadataDeltaMessage} as CONSUMERS parse it (kind-tolerant — see the
 *  lenient-parsing note above MetadataChangeLenient). Producers still emit and
 *  validate the strict shape. */
export const MetadataDeltaMessageLenient = z.object({
  type: z.literal('metadataDelta'),
  seq: z.number().int().positive(),
  fromExclusive: z.number().int().nonnegative().optional(),
  changes: z.array(MetadataChangeLenient),
  ...FeedIdShape,
})
export type MetadataDeltaMessageLenient = z.infer<typeof MetadataDeltaMessageLenient>
