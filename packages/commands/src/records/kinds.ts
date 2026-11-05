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
  IssueIdField,
  IssueProjection,
  IssueType,
  IssueUserStateWire,
  isLayoutKey,
  LayoutKeyField,
  LayoutWire,
  NewIssueId,
  parseLayoutRowId,
  parseUserEntityKey,
  ROW,
  SessionDesired,
  SessionIdField,
  SessionLifecycleFailure,
  SessionMeta,
  SessionUserStateWire,
  UserIdField,
  WorkState,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import { z } from 'zod'
import type { CommandPolicy, DeliveryPolicy, TransportTag } from '../contract'
import {
  ISSUE_ATTRIBUTION,
  ISSUE_REDACTION,
  ISSUE_VISIBILITY,
  PER_USER_VISIBILITY,
  REAUTHORIZATION,
  TARGETED_ERRORS,
} from '../issues/cells'
import { updateInput } from '../issues/contracts'
import { defineSyncedKind, key, label, type SyncedKindDeclaration, spec, status } from './declare'
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

/** Every kind that takes generic edits. */
export const SYNCED_KINDS: readonly SyncedKindDeclaration[] = [
  ISSUE_RECORD,
  SESSION_USER_STATE_RECORD,
  ISSUE_USER_STATE_RECORD,
  USER_LAYOUT_RECORD,
  SESSION_RECORD,
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
  userReadPosition: { reason: 'Read positions convert with their family.', by: 'POD-6359' },
  issueEvent: { reason: 'An append-only history; never edited.', by: 'never (append)' },
  pendingInteraction: { reason: 'Answers are one-off effects.', by: 'POD-6359' },
  message: { reason: 'Chat delivery is an effect on its own record.', by: 'POD-6357' },
  machine: { reason: 'Machine spec moves with POD-5802.', by: 'POD-5802' },
  issueGitState: {
    reason: 'All status: observed by the server, never client-written.',
    by: 'never (status)',
  },
  effect: {
    reason:
      'A state machine (`cmd`), not plain data: created, cancelled and dismissed by its own commands (`effects.*`).',
    by: 'never (effects.*)',
  },
}
