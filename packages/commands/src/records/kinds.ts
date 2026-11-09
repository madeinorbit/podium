/**
 * THE SYNCED KINDS THAT TAKE GENERIC EDITS, AND THE ONES THAT DO NOT YET
 * (ADR 12 D3, POD-6391).
 *
 * Two kinds are declared here first, chosen to cover what the generic path has
 * to get right:
 *
 *  - `issueProjection`: `exp-rev` (a stale revision is refused), a create with a
 *    device-minted `iss_<uuid>` id, and a LABEL the server fills in (`seq`, the
 *    number in POD-6241).
 *  - `sessionUserState`: `single-writer` per-user state, keyed by the person, so
 *    nobody can write somebody else's row.
 *
 * Every other feed kind is listed in {@link NOT_YET_GENERIC} with the task that
 * converts it, so "not declared" is always a decision with an owner and never an
 * omission (`kinds.test.ts` holds the two lists to the feed's kind enum).
 */

import {
  AgentCandidates,
  AgentProfileName,
  AgentProfileWire,
  EffectDecision,
  EffectIdField,
  EffectRecordWire,
  INSTANCE_PREFERENCE_LEAVES,
  InstancePreferencesWire,
  IssueIdField,
  IssueProjection,
  IssueType,
  IssueUserStateWire,
  isLayoutKey,
  LayoutKeyField,
  LayoutWire,
  MAX_AGENT_PROFILE_INSTRUCTIONS,
  MachineIdField,
  MachineProjection,
  NewIssueId,
  PinWire,
  parseInstancePreferencesRowId,
  parseLayoutRowId,
  parsePinRowId,
  parseReadPositionRowId,
  parseSuperagentThreadRowId,
  parseSubscriptionRowId,
  parseTabOrderRowId,
  parseUserEntityKey,
  parseUserPreferencesRowId,
  parseWorkflowBindingRowId,
  ReadPositionWire,
  ReadStreamIdField,
  ROW,
  SessionDesired,
  SessionIdField,
  SessionLifecycleFailure,
  SessionMeta,
  SessionUserStateWire,
  SuperagentThreadKind,
  SuperagentThreadWire,
  SuperagentTurnFailureWire,
  SubscriberKind,
  SubscriptionOrigin,
  SubscriptionSourceKind,
  SubscriptionWire,
  TabOrderWire,
  ThreadIdField,
  UpdateChannel,
  USER_PREFERENCE_LEAVES,
  UserIdField,
  UserPreferencesWire,
  WorkflowBindingTarget,
  WorkflowBindingWire,
  WorkState,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import { z } from 'zod'
import type { CommandPolicy, DeliveryPolicy, ErrorConsistency, TransportTag } from '../contract'
import {
  ISSUE_ATTRIBUTION,
  ISSUE_REDACTION,
  ISSUE_VISIBILITY,
  PER_USER_VISIBILITY,
  REAUTHORIZATION,
  TARGETED_ERRORS,
} from '../issues/cells'
import { updateInput } from '../issues/contracts'
import {
  defineSyncedKind,
  key,
  label,
  type RecordField,
  type SyncedKindDeclaration,
  spec,
  status,
} from './declare'
import { ISSUE_FIELD_DEFAULTS as DEFAULT, ISSUE_FRESH } from './issue-fresh'

/** The family's `issues.update` patch: a plain field parses as it does there. */
const UPDATE = updateInput.shape.patch.shape

/** One of an issue's plain fields (POD-6405): its own field-LWW group. */
const plain = <S extends z.ZodTypeAny>(
  schema: S,
  opts: { required?: true; default?: z.input<S> } = {},
) => spec(schema, ROW.issuePlainFields, { ...opts, conflict: 'field-LWW' })

/** An issue's labels as the server stores them: trimmed, deduplicated, sorted. */
const IssueLabels = z
  .array(z.string())
  .transform((labels) => [...new Set(labels.map((l) => l.trim()).filter(Boolean))].sort())

/** `sync.submit` is served over tRPC; the other adapters come with POD-6359. */
const SUBMIT_ONLY: readonly TransportTag[] = ['trpc']

/** Served over tRPC and through an agent's relay. */
const SUBMIT_AND_RELAY: readonly TransportTag[] = ['trpc', 'relay']

const QUEUED: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'QUEUED through the client outbox onto `sync.submit` (ADR 12 D2/D6). The entry point dedups by ' +
    'the envelope mutationId; the device shows the patch itself until the outbox entry retires by ' +
    'receipt or provenance (ADR 12 D7), with no per-command display code.',
  applyTimeReauthorization: REAUTHORIZATION,
}

// ---------------------------------------------------------------------------
// issueProjection
// ---------------------------------------------------------------------------

const ISSUE_EDIT: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'issue',
  confirmation: 'confirm',
  rationale:
    'Edits an EXISTING issue: the target check is the issue family’s own (owner and grants, or the ' +
    'subtree with `--outside-scope` confirmation), exactly as `issues.update`.',
}

const ISSUE_CREATE: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'Additive, as `issues.create`: there is no existing issue to scope against, so the role decides.',
}

export const ISSUE_RECORD = defineSyncedKind({
  kind: 'issueProjection',
  title: 'issue',
  wire: IssueProjection,
  ref: IssueIdField,
  newId: NewIssueId,
  conflict: 'exp-rev',
  placement: { repoPath: z.string().min(1) },
  fields: {
    // Resolved by the server from the create's repo path, inside the same write.
    repoId: label(z.string(), ROW.issueCore),
    // THE PLAIN FIELDS (POD-6405): each its own field-LWW group, so an edit of
    // one never conflicts with an edit of another, as `issues.update` never did.
    // Their schemas are `issues.update`'s own, so a device parses a value the
    // way the server does.
    title: plain(z.string().trim().min(1), { required: true }),
    // Its own row, reserved for collaborative text (op-stream); field-LWW until
    // then, like the plain fields.
    description: spec(z.string(), ROW.issueDocumentFields, {
      default: DEFAULT.description,
      conflict: 'field-LWW',
    }),
    priority: plain(z.number().int().min(0).max(4), { default: DEFAULT.priority }),
    type: plain(IssueType, { default: DEFAULT.type }),
    brief: plain(UPDATE.brief.unwrap()),
    acceptance: plain(UPDATE.acceptance.unwrap()),
    assignee: plain(UPDATE.assignee.unwrap()),
    dueAt: plain(UPDATE.dueAt.unwrap()),
    // An ISO instant, a bare day, or the `next-message` sentinel; cleared
    // (`unset`) ends the snooze quietly, a past instant is an unsnooze.
    deferUntil: plain(UPDATE.deferUntil.unwrap()),
    // The server keeps the set trimmed, without duplicates, in order.
    labels: plain(IssueLabels, { default: DEFAULT.labels }),
    archived: plain(UPDATE.archived.unwrap(), { default: DEFAULT.archived }),
    estimateMin: plain(UPDATE.estimateMin.unwrap()),
    machineId: plain(UPDATE.machineId.unwrap()),
    seq: label(z.number().int(), ROW.issueCore),
    revision: status(z.number().int(), ROW.issueCore),
    updatedAt: status(z.string(), ROW.issueCore),
  },
  ops: {
    create: { policy: ISSUE_CREATE, note: 'A new issue in a repo, not started.' },
    edit: { policy: ISSUE_EDIT, note: 'The plain fields of an existing issue.' },
  },
  visibility: ISSUE_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: ISSUE_REDACTION,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
  creates: {
    creates: ['issue'],
    owner: 'on-behalf-of-human',
    visibility: ISSUE_VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note: 'As `issues.create`: a top-level issue is owned by the creator’s on-behalf-of human.',
  },
  fresh: ISSUE_FRESH,
})

// ---------------------------------------------------------------------------
// sessionUserState
// ---------------------------------------------------------------------------

/** The feed's id of a per-user session row: `userEntityKey(user, session)`. */
const SessionUserStateRef = z.string().refine(
  (id) => {
    try {
      return parseUserEntityKey(id).kind === 'session'
    } catch {
      return false
    }
  },
  { message: 'a per-user session row id' },
)

const PER_USER_EDIT: CommandPolicy = {
  action: 'read',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'Read-grade on the session, write-grade on the caller’s OWN row (ADR 9 D3 rule 4), as ' +
    '`sessions.markRead`: the row’s key names its user, and only that user may write it.',
}

export const SESSION_USER_STATE_RECORD = defineSyncedKind({
  kind: 'sessionUserState',
  title: 'session read state',
  wire: SessionUserStateWire,
  ref: SessionUserStateRef,
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.perUserStateFamily),
    sessionId: key(SessionIdField, ROW.perUserStateFamily),
    readAt: spec(z.string().datetime().nullable(), ROW.sessionReadAt),
    // `null` snoozes until the next message; clearing the cell (`unset`) ends
    // the snooze (POD-6404).
    snoozedUntil: spec(z.string().nullable(), ROW.snooze),
  },
  ops: {
    edit: {
      policy: PER_USER_EDIT,
      note: 'When I last read this session (null marks it unread), and my snooze on it.',
    },
    remove: { policy: PER_USER_EDIT, note: 'Forget my read mark and snooze on this session.' },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A read mark is a timestamp about the caller; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'A session the caller may not read fails as an unknown one; another user’s row the same.',
  },
})

// ---------------------------------------------------------------------------
// issueUserState (POD-6404)
// ---------------------------------------------------------------------------

/** The feed's id of a per-user issue row: `userEntityKey(user, issue)`. */
const IssueUserStateRef = z.string().refine(
  (id) => {
    try {
      return parseUserEntityKey(id).kind === 'issue'
    } catch {
      return false
    }
  },
  { message: 'a per-user issue row id' },
)

const PER_USER_ISSUE_EDIT: CommandPolicy = {
  ...PER_USER_EDIT,
  rationale:
    'Read-grade on the issue, write-grade on the caller’s OWN row (ADR 9 D3 rule 4), as ' +
    '`issues.markRead` and `issues.setTucked`: the row’s key names its user, and only that user ' +
    'may write it.',
}

export const ISSUE_USER_STATE_RECORD = defineSyncedKind({
  kind: 'issueUserState',
  title: 'issue read state',
  wire: IssueUserStateWire,
  ref: IssueUserStateRef,
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.perUserStateFamily),
    entityId: key(IssueIdField, ROW.perUserStateFamily),
    readAt: spec(z.string().datetime().nullable(), ROW.issueMessageReadAt),
    // Only a finished issue can be tucked into the Closed fold; the server keeps
    // the first tuck's stamp.
    tuckedAt: spec(z.string().datetime().nullable(), ROW.issueMessageReadAt),
  },
  ops: {
    edit: {
      policy: PER_USER_ISSUE_EDIT,
      note: 'When I last read this issue (null marks it unread), and whether I tucked it away.',
    },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Read and tuck marks are timestamps about the caller; nothing on them is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'An issue the caller may not read fails as an unknown one; another user’s row the same.',
  },
})

// ---------------------------------------------------------------------------
// userLayout (POD-6404)
// ---------------------------------------------------------------------------

/** The feed's id of one layout row: `layoutRowId(user, key)`, a key from the
 *  closed vocabulary. */
const LayoutRowRef = z.string().refine(
  (id) => {
    try {
      return isLayoutKey(parseLayoutRowId(id).key)
    } catch {
      return false
    }
  },
  { message: 'a layout row id' },
)

const LAYOUT_WRITE: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'A member writes their OWN layout row, as `layout.set` / `layout.clear`: the row id names its ' +
    'user, and only that user may write it. No confirmation: every leaf is reversible.',
}

export const USER_LAYOUT_RECORD = defineSyncedKind({
  kind: 'userLayout',
  title: 'layout setting',
  wire: LayoutWire,
  ref: LayoutRowRef,
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.sidebarTabLayout),
    key: key(LayoutKeyField, ROW.sidebarTabLayout),
    value: spec(z.unknown(), ROW.sidebarTabLayout),
  },
  ops: {
    edit: { policy: LAYOUT_WRITE, note: 'Set one layout key (a section collapse, a panel mode).' },
    remove: { policy: LAYOUT_WRITE, note: 'Forget one layout key, so the default shows.' },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Layout keys are shell chrome from a closed vocabulary; nothing on them is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Another user’s row fails as an unknown one; the key is from a closed public vocabulary.',
  },
})

// ---------------------------------------------------------------------------
// session: lifecycle as desired state (ADR 12 D5 E1, POD-6356)
// ---------------------------------------------------------------------------

const SESSION_LIFECYCLE_EDIT: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'session',
  confirmation: 'none',
  machineVerb: 'use',
  rationale:
    'Stop, hibernate and resume as an edit of what the session should be. The target check is the ' +
    'command plane’s own for `sessions.stop` (owner or grant, issue scope, machine `use`), so the ' +
    'edit is never weaker than the route it replaces; the server’s controller acts after commit.',
}

const SESSION_KILL: CommandPolicy = {
  ...SESSION_LIFECYCLE_EDIT,
  rationale:
    'Kill deletes the session row (as `sessions.kill` always has: a tombstone and a remove change, ' +
    'then the daemon is signalled after commit). Against the record’s revision, so a queued kill ' +
    'that arrives after a newer start is refused instead of ending the process the user resumed.',
}

/**
 * The session's lifecycle fields only. Rename, archive and work state join this
 * declaration as plain edits under the same spec revision with POD-6355.
 */
export const SESSION_RECORD = defineSyncedKind({
  kind: 'session',
  title: 'session',
  wire: SessionMeta,
  ref: SessionIdField,
  conflict: 'exp-rev',
  revisionField: 'revision',
  fields: {
    desired: spec(SessionDesired, ROW.sessionDesiredState),
    // Qualifies THIS edit of `desired`: a stop that discards unsaved work. An
    // edit that omits it writes false, so a force never outlives its stop.
    force: spec(z.boolean(), ROW.sessionDesiredState),
    revision: status(z.number().int(), ROW.sessionDesiredState),
    observedRevision: status(z.number().int(), ROW.sessionDesiredState),
    lifecycleFailure: status(SessionLifecycleFailure, ROW.sessionDesiredState),
    // THE LABELS (POD-6406): plain fields, each its own field-LWW group, as
    // their commands always were (they carried no revision). They never move
    // the spec revision, so a rename never makes a queued stop stale.
    // As `sessions.rename` takes it; the server stores it trimmed, so it parses so.
    name: spec(z.string().trim().max(120), ROW.sessionLabels, { conflict: 'field-LWW' }),
    archived: spec(z.boolean(), ROW.sessionLabels, { conflict: 'field-LWW' }),
    // Cleared (`unset`) for no work state.
    workState: spec(WorkState, ROW.sessionLabels, { conflict: 'field-LWW' }),
  },
  ops: {
    edit: {
      policy: SESSION_LIFECYCLE_EDIT,
      note: 'Stop (`stopped`, `force` to discard unsaved work), hibernate, or resume (`running`).',
    },
    remove: { policy: SESSION_KILL, note: 'Kill: end the process and delete the session.' },
  },
  visibility: 'personal',
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A desired state, a force flag and a revision; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'A session the caller may not command fails as an unknown one, as `sessions.stop`.',
  },
})

// ---------------------------------------------------------------------------
// per-user records: pin, tabOrder, userPreferences, userReadPosition (POD-6673, ADR 12 D1)
// ---------------------------------------------------------------------------

/** A feed id a parser accepts, as a ref schema. */
const rowRef = (parse: (id: string) => unknown, message: string) =>
  z.string().refine(
    (id) => {
      try {
        parse(id)
        return true
      } catch {
        return false
      }
    },
    { message },
  )

const OWN_ROW_WRITE: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'A member writes their OWN per-user row (ADR 9 D3 rule 4): the row id names its user, and only ' +
    'that user may write it. No confirmation: every pin, order and preference is reversible.',
}

const OWN_ROW_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note: 'Another user’s row fails as an unknown one; a pin of a session the caller may not read the same.',
}

const PinRowRef = rowRef(parsePinRowId, 'a pin row id')

/**
 * A PIN: the record's existence is the pin (design 1.1). Pin = create, unpin =
 * remove; nothing to edit. Pinning what is already pinned keeps the first pin
 * (`recreate: 'keep'`), so a create and a remove are idempotent by key.
 */
export const PIN_RECORD = defineSyncedKind({
  kind: 'pin',
  title: 'pin',
  wire: PinWire,
  ref: PinRowRef,
  // The id is the key itself, `pinRowId(user, kind, entity)`: one pin per thing.
  newId: PinRowRef,
  recreate: 'keep',
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.pins, { required: true }),
    kind: key(PinWire.shape.kind, ROW.pins, { required: true }),
    entityId: key(z.string().min(1), ROW.pins, { required: true }),
    pinnedAt: status(z.string(), ROW.pins),
  },
  ops: {
    create: { policy: OWN_ROW_WRITE, note: 'Pin a session, an issue, a worktree or a repo.' },
    remove: { policy: OWN_ROW_WRITE, note: 'Unpin it.' },
  },
  visibility: PER_USER_VISIBILITY,
  // An agent pins for its human too (`podium issue update --pinned`, POD-6692),
  // as it could while a pin was a field of the task. The adapter's own-human
  // check is the guard: a pin row naming anybody else is unknown.
  exposure: SUBMIT_AND_RELAY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A pin names a thing the caller can see; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: OWN_ROW_ERRORS,
  creates: {
    creates: ['pin'],
    owner: 'on-behalf-of-human',
    visibility: PER_USER_VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note: 'The caller’s own pin; its id names them, so nobody pins for somebody else.',
  },
  fresh: {
    cells: {},
    // The server's clock; the device's queue time until then.
    pending: { pinnedAt: (ctx) => ctx.at },
  },
})

/**
 * A WORKTREE'S TAB ORDER (design 1.2): whole-list last-writer-wins, since a
 * merge of two orderings means nothing. An empty list removes the record.
 */
export const TAB_ORDER_RECORD = defineSyncedKind({
  kind: 'tabOrder',
  title: 'tab order',
  wire: TabOrderWire,
  ref: rowRef(parseTabOrderRowId, 'a tab order row id'),
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.tabOrder),
    entityId: key(z.string().min(1), ROW.tabOrder),
    // An empty list is no order: the server removes the record.
    sessionIds: spec(z.array(z.string()), ROW.tabOrder),
  },
  ops: {
    edit: { policy: OWN_ROW_WRITE, note: 'Set the manual session order of one worktree.' },
    remove: { policy: OWN_ROW_WRITE, note: 'Forget it, so sessions show in their own order.' },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A list of the caller’s session ids; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: OWN_ROW_ERRORS,
})

/** One personal preference leaf as a field: a plain field, its own leaf. */
const preferenceLeafFields: Record<string, RecordField> = Object.fromEntries(
  [...USER_PREFERENCE_LEAVES].map(([path, schema]) => [
    path,
    spec(schema, ROW.preferencesPersonal),
  ]),
)

/**
 * ONE PERSON'S PERSONAL PREFERENCES (design 1.3): one record per user whose
 * fields are the `personal-preference` tier's leaf paths. Single-writer (the
 * user is the key, as the matrix row says); a patch writes only the leaves it
 * names, so two devices changing different settings never overwrite each
 * other, and the last write of one leaf wins. A cleared leaf (`unset`) resets it
 * to the default. Server secrets are not leaves of it.
 */
export const USER_PREFERENCES_RECORD = defineSyncedKind({
  kind: 'userPreferences',
  title: 'personal settings',
  wire: UserPreferencesWire,
  ref: rowRef(parseUserPreferencesRowId, 'a user preferences row id'),
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.preferencesPersonal),
    ...preferenceLeafFields,
  },
  ops: {
    edit: { policy: OWN_ROW_WRITE, note: 'Change or reset my personal settings, leaf by leaf.' },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'Personal preferences only: the classification keeps every server secret out of this tier, ' +
      'and `telegramChatId` is routing config, not a secret (matrix row preferences-personal).',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: OWN_ROW_ERRORS,
})

/**
 * ONE PERSON'S POSITION IN ONE EVENT STREAM (design 1.4; the write became a
 * queued generic edit, POD-6673). The row id names the user and the stream. An
 * edit proposes a position; the server stores max(stored, proposed)
 * (advanceReadPosition), so a stale proposal from a device that wrote before
 * its replica caught up is a no-op and never moves the cursor back. The
 * matrix row is per-user state, single-writer: the user is in the key, and the
 * max is how that one writer's devices agree.
 */
export const USER_READ_POSITION_RECORD = defineSyncedKind({
  kind: 'userReadPosition',
  title: 'read position',
  wire: ReadPositionWire,
  ref: rowRef(parseReadPositionRowId, 'a read position row id'),
  conflict: 'single-writer',
  fields: {
    userId: key(UserIdField, ROW.feedReadCursor),
    streamId: key(ReadStreamIdField, ROW.feedReadCursor),
    lastEventId: spec(z.number().int().nonnegative(), ROW.feedReadCursor),
    seenAt: spec(z.string().nullable(), ROW.feedReadCursor),
  },
  ops: {
    edit: {
      policy: OWN_ROW_WRITE,
      note: 'Move my read position in one stream forward; a position behind it changes nothing.',
    },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A stream name from a closed vocabulary, an event log id and a timestamp; nothing secret.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: OWN_ROW_ERRORS,
})

// ---------------------------------------------------------------------------
// effect: a human gate's decision (POD-6674)
// ---------------------------------------------------------------------------

const EFFECT_DECIDE: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'An edit of one record, gated by that record’s own person, read live: an approval is decided only ' +
    'by the owner of the requesting session (POD-6284), whatever else may read it, and an admin role ' +
    'adds nothing. Not `manage`: that grade is the role’s, and the routed-to person is routinely an ' +
    'ordinary member deciding their own agent’s request. No confirmation: this edit IS the ' +
    'confirmation step the broker exists for.',
}

/**
 * The effect record takes ONE generic edit: a gated kind's `decision`. Create,
 * cancel and dismiss stay the effect commands (`effects.*`), and every status
 * move stays the executor’s. The decision is written once, against the record’s
 * revision: the first decision wins, a stale one is refused, and an `approve`
 * lets the trigger run the record.
 */
export const EFFECT_RECORD = defineSyncedKind({
  kind: 'effect',
  title: 'effect',
  wire: EffectRecordWire,
  ref: EffectIdField,
  conflict: 'exp-rev',
  revisionField: 'revision',
  fields: {
    decision: spec(EffectDecision, ROW.approvals),
    revision: status(z.number().int(), ROW.approvals),
  },
  ops: {
    edit: {
      policy: EFFECT_DECIDE,
      note: 'Approve or deny an agent’s request, once, as the person it is routed to.',
    },
  },
  visibility: 'personal',
  exposure: SUBMIT_ONLY,
  delivery: {
    ...QUEUED,
    outboxReconciliation:
      'QUEUED through the client outbox onto `sync.submit` (ADR 12 D2/D6), like every generic edit. ' +
      'A decision queued offline is made against the record revision it was shown: if anything ' +
      'moved the record since (another device decided first), it is refused, never applied to a ' +
      'request the person did not see. The request’s operation is immutable on the record.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A decision is one word about a record id; it carries no payload and no credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A record the caller may not decide (another person’s approval, a kind with no human gate) ' +
      'fails exactly as an unknown one.',
  },
})

// ---------------------------------------------------------------------------
// superagentThread (POD-6675, design POD-5620 §1.7)
// ---------------------------------------------------------------------------

const THREAD = ROW.superagentThreadFields

/**
 * ONE SUPERAGENT THREAD, its owner's alone. The owner edits its title, archives
 * it, and picks its model and effort (cleared, `unset`, follows the superagent
 * settings role again); each is its own field, last writer wins. Everything
 * else is status the server writes: no client creates a thread by an edit (a
 * thread is made by the superagent's own commands, the global one by the
 * server), and `turnRunning` and `lastTurnFailure` follow the turns.
 */
export const SUPERAGENT_THREAD_RECORD = defineSyncedKind({
  kind: 'superagentThread',
  title: 'superagent thread',
  wire: SuperagentThreadWire,
  ref: rowRef(parseSuperagentThreadRowId, 'a superagent thread row id'),
  conflict: 'field-LWW',
  fields: {
    threadId: key(ThreadIdField, THREAD),
    ownerUserId: key(UserIdField, THREAD),
    title: spec(z.string().trim().min(1).max(200), THREAD),
    archived: spec(z.boolean(), THREAD),
    model: spec(z.string().min(1), THREAD),
    effort: spec(z.string().min(1), THREAD),
    kind: status(SuperagentThreadKind, THREAD),
    originSessionId: status(SessionIdField, THREAD),
    repoPath: status(z.string(), THREAD),
    agentKind: status(z.string(), THREAD),
    podiumSessionId: status(SessionIdField, THREAD),
    resumable: status(z.boolean(), THREAD),
    turnRunning: status(z.boolean(), THREAD),
    lastTurnFailure: status(SuperagentTurnFailureWire.nullable(), THREAD),
    createdAt: status(z.string(), THREAD),
    updatedAt: status(z.string(), THREAD),
  },
  ops: {
    edit: {
      policy: OWN_ROW_WRITE,
      note: 'Rename or archive one of my superagent threads, or set its model and effort.',
    },
  },
  visibility: PER_USER_VISIBILITY,
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A title, an archive flag and a model choice; the harness session id and the terminal lock never leave the server.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Another person’s thread fails as an unknown one, as the superagent commands do.',
  },
})

// ---------------------------------------------------------------------------
// agentProfile, subscription, workflowBinding (POD-6676, ADR 12 D1; design
// POD-5620 §1.9-1.11)
// ---------------------------------------------------------------------------

/** An existing profile's id: a minted `agp_<uuid>` or a starter's `agp_seed_<name>`. */
const AgentProfileRef = z.string().regex(/^agp_[A-Za-z0-9_-]+$/, 'an agent profile id')
/** A new profile's id, minted on the device (ADR 12 D4). */
const NewAgentProfileId = z
  .string()
  .regex(/^agp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'agp_<uuid>')

const AGENT_PROFILE_RATIONALE =
  'Instance-wide configuration every issue and session may point at, so the floor is ADMIN, as ' +
  '`agentProfiles.create/update/delete` were: the matrix row `agent-profiles` says "Write is ' +
  'admin-grade, and never an agent session’s". Flight deck D4’s people-only rule (an agent session ' +
  'is refused even under an admin’s delegation) is the adapter’s target check, because a role floor ' +
  'cannot say it. No `machineVerb`: saving a profile that names a machine places no work there; ' +
  '`use` is checked when a session spawns.'

const AGENT_PROFILE_WRITE: CommandPolicy = {
  action: 'write',
  roleFloor: 'admin',
  resource: 'settings-domain',
  confirmation: 'none',
  rationale: AGENT_PROFILE_RATIONALE,
}

const AGENT_PROFILE_REMOVE: CommandPolicy = {
  action: 'manage',
  roleFloor: 'admin',
  resource: 'settings-domain',
  confirmation: 'none',
  rationale:
    `${AGENT_PROFILE_RATIONALE} A removal deletes the row; it is refused while an open issue points ` +
    'at the profile, and sessions keep the values they ran with.',
}

/**
 * AN AGENT PROFILE (design 1.9): every field but the timestamps is spec,
 * field-level last writer wins. Names stay unique (the adapter refuses a clash),
 * a machine is named by id (the CLI resolves a name first), and a profile an
 * open issue uses cannot be removed. Online only, as before: profile edits are
 * rare and made with the server in reach, and nothing is lost by refusing one
 * offline.
 */
export const AGENT_PROFILE_RECORD = defineSyncedKind({
  kind: 'agentProfile',
  title: 'agent profile',
  wire: AgentProfileWire,
  ref: AgentProfileRef,
  newId: NewAgentProfileId,
  conflict: 'field-LWW',
  fields: {
    name: spec(AgentProfileName, ROW.agentProfiles, { required: true }),
    description: spec(z.string().trim().max(2_000), ROW.agentProfiles, { default: '' }),
    candidates: spec(AgentCandidates, ROW.agentProfiles, { default: [] }),
    machineId: spec(z.string().min(1).nullable(), ROW.agentProfiles, { default: null }),
    instructions: spec(z.string().max(MAX_AGENT_PROFILE_INSTRUCTIONS), ROW.agentProfiles, {
      default: '',
    }),
    createdAt: status(z.string(), ROW.agentProfiles),
    updatedAt: status(z.string(), ROW.agentProfiles),
  },
  ops: {
    create: { policy: AGENT_PROFILE_WRITE, note: 'A new named agent setup.' },
    edit: { policy: AGENT_PROFILE_WRITE, note: 'Change a profile, field by field.' },
    remove: { policy: AGENT_PROFILE_REMOVE, note: 'Delete a profile no open issue uses.' },
  },
  visibility: 'deployment-substrate',
  exposure: SUBMIT_ONLY,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Answered now on `sync.submit` (ADR 12 D2), never queued: profile edits are rare, made from the ' +
      'CLI with the server in reach, and nothing is lost by refusing one offline; the caller runs it ' +
      'again.',
    applyTimeReauthorization:
      'Re-authorized live at apply: the caller’s role is read at that moment, so an admin demoted ' +
      'mid-call is refused.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'Nothing redacted. A profile holds harness and model NAMES, effort levels, a machine reference ' +
      'and instruction text written by the instance’s own people; no credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Every profile is visible to every member (substrate): there is no hidden row to reveal.',
  },
  creates: {
    creates: ['agent-profile'],
    owner: 'on-behalf-of-human',
    visibility: 'deployment-substrate',
    inheritanceOnCreate: 'on-behalf-of-human',
    note:
      'A profile has no owner (`owner: none, substrate`): it belongs to the deployment. Its creator ' +
      'is recorded as `created_by`, history only, never a grant.',
  },
  fresh: {
    cells: {},
    pending: { createdAt: (ctx) => ctx.at, updatedAt: (ctx) => ctx.at },
  },
})

const SUBSCRIPTION_WRITE: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'A subscription is its SUBSCRIBER’s (POD-6288): a person changes only one whose subscriber is a ' +
    'session they own or a task assigned to them, an agent only its own derived subscriber’s, as ' +
    '`issues.subscriptionSetEnabled` and `subscriptionRemove` did. Admins get the same: a nudge ' +
    'drives the subscriber’s agent, so nobody else’s is theirs to change. No confirmation: a toggle ' +
    'is reversible and a removal changes only what wakes the caller’s own agent.',
}

/**
 * AN AUTOMATION TRIGGER SUBSCRIPTION (design 1.11). `enabled` is its one spec
 * field and removing it the other write, both its subscriber's own. A
 * subscription is created by `issues.subscriptionAdd`, which resolves the
 * source and checks the watched source is in reach. The row id carries the
 * subscriber (`subscriptionRowId`).
 */
export const SUBSCRIPTION_RECORD = defineSyncedKind({
  kind: 'subscription',
  title: 'subscription',
  wire: SubscriptionWire,
  ref: rowRef(parseSubscriptionRowId, 'a subscription row id'),
  conflict: 'single-writer',
  fields: {
    subscriberKind: key(SubscriberKind, ROW.eventSubscriptions),
    subscriberId: key(z.string(), ROW.eventSubscriptions),
    event: key(z.string(), ROW.eventSubscriptions),
    sourceKind: key(SubscriptionSourceKind, ROW.eventSubscriptions),
    sourceRef: key(z.string(), ROW.eventSubscriptions),
    deliverNudge: key(z.boolean(), ROW.eventSubscriptions),
    deliverNotify: key(z.boolean(), ROW.eventSubscriptions),
    origin: status(SubscriptionOrigin, ROW.eventSubscriptions),
    enabled: spec(z.boolean(), ROW.eventSubscriptions),
    createdAt: status(z.string(), ROW.eventSubscriptions),
  },
  ops: {
    edit: { policy: SUBSCRIPTION_WRITE, note: 'Turn one of my trigger subscriptions on or off.' },
    remove: { policy: SUBSCRIPTION_WRITE, note: 'Remove one of my trigger subscriptions.' },
  },
  visibility: 'personal',
  // An agent removes its own subscriptions (`podium issue subscription remove`).
  exposure: SUBMIT_AND_RELAY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'An event name, a source reference and two flags; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Another subscriber’s subscription fails as an unknown one.',
  },
})

const WORKFLOW_BINDING_WRITE: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'issue',
  confirmation: 'confirm',
  rationale:
    'As `workflows.assign`: a binding attaches a revision the caller may read to a target, and the ' +
    'authority it needs is over the TARGET. An issue binding needs the issue (an agent’s scope, ' +
    'widened by its confirmation), a session binding that session and its machine’s `use`; the ' +
    'global and repository arms are substrate and admin-grade, and take only a published revision.',
}

/**
 * WHICH WORKFLOW REVISION A TARGET RUNS (design 1.10): `{ targetKind,
 * targetId } → revisionId`, keyed by the target (`workflowBindingRowId`), one
 * per target, last writer wins. An edit sets it whether or not one was set
 * before; there is no create.
 */
export const WORKFLOW_BINDING_RECORD = defineSyncedKind({
  kind: 'workflowBinding',
  title: 'workflow binding',
  wire: WorkflowBindingWire,
  ref: rowRef((id) => {
    if (parseWorkflowBindingRowId(id) === undefined) throw new Error('not a binding id')
  }, 'a workflow binding row id'),
  conflict: 'field-LWW',
  fields: {
    targetKind: key(WorkflowBindingTarget, ROW.workflowBindings),
    targetId: key(z.string(), ROW.workflowBindings),
    revisionId: spec(z.string().min(1), ROW.workflowBindings),
    updatedAt: status(z.string(), ROW.workflowBindings),
  },
  ops: {
    edit: { policy: WORKFLOW_BINDING_WRITE, note: 'Make a target run a workflow revision.' },
  },
  visibility: 'personal',
  // An agent binds its own session (`podium workflow assign`), as before.
  exposure: SUBMIT_AND_RELAY,
  // Offline-eligible, as `workflows.assign` was: the checks run at apply, live.
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A target reference and a revision id; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note:
      'A revision the caller may not read fails as an unknown one; the one carve-out is placement: ' +
      'a session on a machine the caller may not use is unauthorized, one that is offline is ' +
      'unreachable (readiness §3.1.4 M5), as `workflows.assign`.',
  },
})

// ---------------------------------------------------------------------------
// instancePreferences (POD-6677, design POD-5620 §1.5)
// ---------------------------------------------------------------------------

/**
 * An ADMIN writes the instance's settings: one answer for everybody on the
 * instance, so the floor is admin, as the matrix row's writers (`operator`) say.
 * The adapter reads the account's role live, so a demoted admin's queued edit is
 * refused at apply.
 */
const INSTANCE_PREFERENCES_EDIT: CommandPolicy = {
  action: 'write',
  roleFloor: 'admin',
  resource: 'settings-domain',
  confirmation: 'none',
  rationale:
    'One answer for the whole deployment, so the floor is ADMIN (matrix row preferences-instance: ' +
    'writers `operator`, "Write is admin-grade"). No confirmation: every leaf is a toggle or a ' +
    'number, reversible by writing it again; the admin floor answers the instance-wide blast radius.',
}

/** One instance preference leaf as a field: a plain field, its own leaf. */
const instanceLeafFields: Record<string, RecordField> = Object.fromEntries(
  [...INSTANCE_PREFERENCE_LEAVES].map(([path, schema]) => [
    path,
    spec(schema, ROW.preferencesInstance),
  ]),
)

/**
 * THE INSTANCE PREFERENCES (design 1.5): one record for the whole instance whose
 * fields are the `instance-preference` tier's leaf paths. Field-level
 * last-writer-wins per leaf, the rule matrix row `preferences-instance` keeps for
 * this tier: two admins changing different settings never overwrite each other.
 * A cleared leaf (`unset`) resets it to the default; reset is a write, never a
 * delete. Every member reads it (`deployment-substrate`); server secrets are not
 * leaves of it.
 */
export const INSTANCE_PREFERENCES_RECORD = defineSyncedKind({
  kind: 'instancePreferences',
  title: 'instance settings',
  wire: InstancePreferencesWire,
  ref: rowRef(parseInstancePreferencesRowId, 'the instance preferences row id'),
  conflict: 'field-LWW',
  fields: instanceLeafFields,
  ops: {
    edit: {
      policy: INSTANCE_PREFERENCES_EDIT,
      note: 'Change or reset the instance settings, leaf by leaf (admins only).',
    },
  },
  visibility: 'deployment-substrate',
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'Instance preferences only: the classification keeps every server secret out of this tier ' +
      '(matrix row preferences-instance, `secret: preference`); `experimental` is a preference.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'A member who is not an admin is refused as for an unknown record: there is one record.',
  },
})

// ---------------------------------------------------------------------------
// machine: its spec, a manager's (POD-6644, design POD-5620 §1.12)
// ---------------------------------------------------------------------------

const MACHINE_EDIT: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'machine',
  machineVerb: 'manage',
  confirmation: 'none',
  rationale:
    'ADR 9 D6 M1: renaming a machine and choosing its update authority are `manage` acts, held by ' +
    'its owner and the admins, as `machines.rename` and `machines.setUpdateChannel` were. The floor ' +
    'is `member` so the OWNER reaches it; which machines a member may touch is the fleet gate’s ' +
    'per-machine check. Neither runs anything on the machine, so both work while it is offline.',
}

/**
 * A MACHINE'S SPEC. The `machine` record is display facts every member reads;
 * its two spec fields are the name and the update-channel pin, written by its
 * owner or an admin. Each is its own field-LWW group, as their commands always
 * were. Everything else on the record is status, written by the server.
 */
export const MACHINE_RECORD = defineSyncedKind({
  kind: 'machine',
  title: 'machine',
  wire: MachineProjection,
  ref: MachineIdField,
  conflict: 'field-LWW',
  fields: {
    // As `machines.rename` took it; stored trimmed, so it parses so.
    name: spec(z.string().trim().min(1).max(80), ROW.machineSpec),
    // `null`: no pin, the machine follows the fleet default (POD-1882).
    updateChannelOverride: spec(UpdateChannel.nullable(), ROW.machineSpec),
  },
  ops: {
    edit: {
      policy: MACHINE_EDIT,
      note: 'Rename a machine, or pin or unpin the channel it updates from.',
    },
  },
  visibility: 'owned-compute',
  exposure: SUBMIT_ONLY,
  delivery: QUEUED,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'A machine name and a channel name; nothing on it is a credential.',
  },
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A machine the caller cannot manage fails exactly as an unknown id (Amendment 1 D20.2). An ' +
      'edit never reaches the machine, so there is no unreachable state to report.',
  },
})

/** Every kind that takes generic edits. */
export const SYNCED_KINDS: readonly SyncedKindDeclaration[] = [
  ISSUE_RECORD,
  SESSION_USER_STATE_RECORD,
  ISSUE_USER_STATE_RECORD,
  USER_LAYOUT_RECORD,
  SESSION_RECORD,
  PIN_RECORD,
  TAB_ORDER_RECORD,
  USER_PREFERENCES_RECORD,
  USER_READ_POSITION_RECORD,
  EFFECT_RECORD,
  SUPERAGENT_THREAD_RECORD,
  AGENT_PROFILE_RECORD,
  SUBSCRIPTION_RECORD,
  WORKFLOW_BINDING_RECORD,
  INSTANCE_PREFERENCES_RECORD,
  MACHINE_RECORD,
]

/**
 * The feed kinds that do not take generic edits yet, each with why and who
 * converts it. Plan tasks: 12 plain edits (POD-6355), 13 session desired state
 * (POD-6356), 14 effect records (POD-6357), 16 remaining writes (POD-6359);
 * POD-5802 makes the new synced kinds.
 */
export const NOT_YET_GENERIC: Readonly<
  Record<
    Exclude<MetadataEntityKind, (typeof SYNCED_KINDS)[number]['kind']>,
    { readonly reason: string; readonly by: string }
  >
> = {
  issueDep: { reason: 'Graph edges with cycle rules (`cmd`).', by: 'POD-6359' },
  repo: { reason: 'Repo config moves with the repos family.', by: 'POD-6359' },
  shipOrder: { reason: 'Shipping is system-owned.', by: 'POD-6359' },
  shipLane: { reason: 'Shipping is system-owned.', by: 'POD-6359' },
  conversation: { reason: 'Titles convert with the conversations family.', by: 'POD-6359' },
  automation: {
    reason:
      'Its schedule rules (validation, the re-arm, the run cascade) are server commands on sync.submit (`automations.*`, POD-6418).',
    by: 'never (automations.*)',
  },
  automationRun: {
    reason:
      'All status: written by the scheduler, never client-written; read as an effect through `automationRunEffect` (POD-6418).',
    by: 'never (status)',
  },
  issueEvent: { reason: 'An append-only history; never edited.', by: 'never (append)' },
  pendingInteraction: { reason: 'Answers are one-off effects.', by: 'POD-6359' },
  message: { reason: 'Chat delivery is an effect on its own record.', by: 'POD-6357' },
  machineAccess: {
    reason: 'All status: each member’s access, decided by the server from grants and custody.',
    by: 'never (status)',
  },
  checkout: {
    reason: 'All status: written by the server from the machine’s scans, never client-written.',
    by: 'never (status)',
  },
  issueGitState: {
    reason: 'All status: observed by the server, never client-written.',
    by: 'never (status)',
  },
  workflow: {
    reason:
      'A definition is written with its revisions: create, fork, revise and publish append a revision or move the server’s revision pointers (`append`/`cmd`), on sync.submit as `workflows.*`; no field takes a plain edit (POD-6676).',
    by: 'never (workflows.*)',
  },
  workflowRevision: {
    reason:
      'Immutable once written: appended by `workflows.revise` and stamped by `workflows.publish`.',
    by: 'never (append)',
  },
  workflowRun: {
    reason:
      'All status: the run state machine is the server’s, moved by the run commands (`workflows.*`).',
    by: 'never (status)',
  },
}
