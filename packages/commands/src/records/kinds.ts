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
  NewIssueId,
  parseUserEntityKey,
  ROW,
  SessionIdField,
  SessionUserStateWire,
  UserIdField,
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
import { defineSyncedKind, key, label, type SyncedKindDeclaration, spec, status } from './declare'

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
    title: spec(z.string().trim().min(1), ROW.issueCore, { required: true }),
    description: spec(z.string(), ROW.issueDocumentFields),
    priority: spec(z.number().int().min(0).max(4), ROW.issueCore),
    type: spec(IssueType, ROW.issueCore),
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
  },
  ops: {
    edit: { policy: PER_USER_EDIT, note: 'When I last read this session; null marks it unread.' },
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

/** Every kind that takes generic edits. */
export const SYNCED_KINDS: readonly SyncedKindDeclaration[] = [
  ISSUE_RECORD,
  SESSION_USER_STATE_RECORD,
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
  session: {
    reason: 'Rename, archive and work state convert as plain edits; lifecycle is desired state.',
    by: 'POD-6355, POD-6356',
  },
  issueDep: { reason: 'Graph edges with cycle rules (`cmd`).', by: 'POD-6359' },
  repo: { reason: 'Repo config moves with the repos family.', by: 'POD-6359' },
  shipOrder: { reason: 'Shipping is system-owned.', by: 'POD-6359' },
  shipLane: { reason: 'Shipping is system-owned.', by: 'POD-6359' },
  conversation: { reason: 'Titles convert with the conversations family.', by: 'POD-6359' },
  automation: { reason: 'Automations convert with their family.', by: 'POD-6359' },
  automationRun: { reason: 'A run is an effect record.', by: 'POD-6357' },
  userLayout: { reason: 'Layout converts as a plain edit.', by: 'POD-6355' },
  userReadPosition: { reason: 'Read positions convert with their family.', by: 'POD-6359' },
  issueEvent: { reason: 'An append-only history; never edited.', by: 'never (append)' },
  pendingInteraction: { reason: 'Answers are one-off effects.', by: 'POD-6357' },
  message: { reason: 'Chat delivery is an effect on its own record.', by: 'POD-6357' },
  issueUserState: {
    reason:
      'Read and tuck marks convert as plain edits; today they are written for the broadcast viewer, not the caller.',
    by: 'POD-6355',
  },
  machine: { reason: 'Machine spec moves with POD-5802.', by: 'POD-5802' },
  issueGitState: {
    reason: 'All status: observed by the server, never client-written.',
    by: 'never (status)',
  },
}
