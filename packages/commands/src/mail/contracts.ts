/**
 * THE agent-mail command contracts (POD-728 step 2, completed by POD-729 step 3
 * of the POD-640 mini-epic).
 *
 * Five verticals: `send`, `reply`, `spawnAgent`, `awaitAgent`, `inboxConsume`,
 * plus the `ledger` query whose exposure class POD-728 had to reclassify — and
 * then the five POD-728 deliberately left behind (`show`, `dismiss`, `status`,
 * `pendingReminders`, `ask`), classified at the bottom of this file so the
 * hand-written arm of `MessageGate.dispatch` could be DELETED rather than halved.
 * Contracts only — every handler lives in `apps/server/src/modules/messages/
 * handlers` and is joined here-to-there at the composition root (ADR 3 D1
 * finding 1: a handler at L1 would drag L3 services into an L1 package).
 *
 * THE OFFLINE-CLASS DECISION, MADE RATHER THAN DEFAULTED
 * -----------------------------------------------------
 * Mail is durable-queued by design, and it would be easy to read that as
 * "offline-eligible". It is not, and ADR 3 D4 rule 4 says why in as many words:
 * a server-held queue for an unreachable AGENT (`queued_messages` / `queueText`)
 * is "a delivery mechanism for already-authorized online commands, NOT a client
 * Outbox offline class". Two different durabilities:
 *
 *  - the KERNEL OUTBOX is a CLIENT-side queue of commands the authority has not
 *    yet seen. Its contents are unauthorized until drain (ADR 3 D8/D9).
 *  - the MAIL QUEUE is a SERVER-side queue of messages the authority has already
 *    accepted, ordered behind a recipient that is asleep. Its contents are rows,
 *    not commands.
 *
 * So every mail mutation here is `online-only`: the send is authorized on a live
 * path, and what survives the recipient's absence is the accepted row, not the
 * command envelope. Classifying it `offline-eligible` would have put mail
 * envelopes in the client Outbox, where a replica holding only its slice
 * (POD-1077) would enqueue sends against ids it can no longer see.
 *
 * The corollary, and the reason `applyTimeReauthorization` is a required field:
 * because the accepted row is drained later, a send whose principal LOST access
 * between accept and drain must be REJECTED at apply and surfaced to its sender —
 * not silently dropped, and not applied. That is ADR 3 D8's apply-time
 * re-authorization meeting readiness §3.1.3 A1's live delegation resolution, and
 * it is the reason the delegation is re-resolved at drain instead of a capability
 * being snapshotted at accept.
 */

import { IssueIdField, SessionIdField } from '@podium/model'
import { MAX_AGENT_TITLE_LENGTH } from '@podium/protocol'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
} from '../contract'

// ---------------------------------------------------------------------------
// Shared policy fragments
// ---------------------------------------------------------------------------

/** The mail mutation delivery class, with its reconciliation and its D8 clause.
 *  One constant so the five contracts cannot drift into three answers. */
const DURABLE_QUEUED_ONLINE: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'DELIBERATE, not defaulted. Mail is durable-queued, but the durability is the SERVER-side ' +
    'queue for an unreachable agent (queued_messages / queueText), which ADR 3 D4 rule 4 defines ' +
    'as a delivery mechanism for an ALREADY-AUTHORIZED online command — not a client Outbox ' +
    'offline class. The kernel Outbox holds commands the authority has not seen; the mail queue ' +
    'holds rows it has already accepted. `outbox` is therefore absent from every mail exposure ' +
    'set (ADR 3 D3 rule 2 / D4 rule 3), and no mail envelope is ever enqueued by a replica that ' +
    'holds only its slice.',
  applyTimeReauthorization:
    'Re-authorized at DRAIN, not at accept (ADR 3 D8 / Amendment 1 D16). The drain re-resolves ' +
    'the delegation chain live, so a sender whose human was revoked — or whose access to the ' +
    'target was withdrawn — between accept and drain is REJECTED at apply. The rejection is ' +
    'surfaced to the sender through the dead-letter path (ADR 3 D9: never a silent drop), and ' +
    'the message is never applied. A capability snapshotted at accept would have let it through.',
}

/** The attribution pair, and the wire-shape decision this issue had to make. */
const MAIL_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'DECISION: on-behalf-of is a SEPARATE wire field; MessageWire.from/to do not carry the pair. ' +
    'from/to are ROUTING addresses — a mailbox, answering "where does this go" — while actor and ' +
    'on-behalf-of are ACCOUNTABILITY, answering "who is answerable". Folding them together makes ' +
    '`from` ambiguous exactly where the product depends on it being unambiguous: `issue:#12` would ' +
    'name either the agent that wrote the row or the human it acted for, and the human-outranks-' +
    'agent rules ([spec:SP-eb60] nameSource, server-authoritative humanQuestionAskedBy) exist ' +
    'precisely so that question stays answerable. Recorded now because a wire shape is cheap ' +
    'before the POD-308 cutover and expensive after it. The KEYS are reserved here; the values ' +
    "arrive with POD-1075's User aggregate, which is what gives on-behalf-of something to hold — " +
    'a message row has no column for a UserId until then, and reserving the name is the part that ' +
    'has to happen before the freeze.',
}

const NO_SECRETS = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Message bodies are user content, not secrets, and are deliberately byte-faithful on the ' +
    'delivery path — redacting them would break the substrate invariant the receiver trusts. ' +
    'Nothing in these inputs or outputs is credential material: no tokens, no machine secrets, no ' +
    'account credentials. What the ERROR paths may say is governed separately by the ' +
    'consistent-error rule below (ADR 3 Amendment 1 D20.4: redaction governs what a denial may ' +
    'SAY, error-consistency governs what it may DISTINGUISH).',
} as const

/** The oracle rule for every command taking a caller-supplied mail address. */
const ADDRESS_ORACLE_RULE = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'Beyond the human ceiling and nonexistent are ONE resolution value, not two rendered alike ' +
    "(see resolveAddress in ./ceiling.ts). Outside the agent's own subtree but INSIDE its " +
    "human's visibility is a different case and stays a confirm-required widening " +
    '(`--outside-scope`), which may name the target because the human can already see it.',
} as const

// ---------------------------------------------------------------------------
// Input schemas — the ONE validation source for every transport (ADR 3 D1)
// ---------------------------------------------------------------------------

export const mailSendInput = z.object({
  to: z.string().min(1),
  body: z.string().min(1).max(32_768),
  urgency: z.enum(['fyi', 'next-turn', 'interrupt']).optional(),
  lifecycle: z.enum(['wait', 'wake']).optional(),
  expectResponse: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
})

export const mailReplyInput = z.object({
  id: z.string(),
  body: z.string().min(1).max(32_768),
  kind: z.enum(['ack', 'message']).optional(),
})

export const mailInboxInput = z.object({ issue: z.string().optional() }).optional()

export const mailLedgerInput = z.object({
  issueId: IssueIdField.optional(),
  sessionId: SessionIdField.optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export const spawnAgentInput = z.object({
  issue: z.string().optional(),
  newTitle: z.string().min(1).optional(),
  repo: z.string().optional(),
  harness: z.string().optional(),
  prompt: z.string().min(1).max(32_768),
  worktree: z.boolean().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  force: z.boolean().optional(),
  title: z.string().min(1).max(MAX_AGENT_TITLE_LENGTH).optional(),
  workflowRunId: z.string().max(256).optional(),
  workflowStepId: z.string().max(256).optional(),
  executionProfileId: z.string().max(256).optional(),
})

export const awaitAgentInput = z.object({
  sessionId: SessionIdField,
  timeoutSeconds: z.number().min(0).max(300).optional(),
})

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

export const mailSendContract: CommandContract<typeof mailSendInput> = {
  name: 'mail.send',
  version: 1,
  visibility: 'personal',
  input: mailSendInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'confirm',
    rationale:
      'RATIFIED, not redesigned (ADR 3 Amendment 1 D20.1). `resource: none` records the shipped ' +
      'send-without-read primitive: addressing another issue is the whole point of a tracker ' +
      'mailbox, so a cross-issue send must not require --outside-scope, and the role gate still ' +
      'applies. Two arms stay DISTINCT inside the handler and that is deliberate: a ' +
      'session-addressed send passes the session-target gate, while an issue-addressed send is a ' +
      '`write` checked against the RESOLVED target issue with --outside-scope for a cross-subtree ' +
      'target. Unlike the append-only issues-registry mailSend these messages carry ' +
      'urgency/lifecycle — wake, resurrect, spawn — so a cross-subtree send is a real act on ' +
      "someone else's subtree and earns its confirmation. The confirmation only crosses scope; it " +
      'never elevates the clamp matrix. Above both arms sits the human ceiling: the bound on ' +
      "addressing is the delegating human's CURRENT rights (§3.1.5, D20.2), resolved at every " +
      "apply, never the agent's own scope and never a snapshot.",
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: DURABLE_QUEUED_ONLINE,
  redaction: NO_SECRETS,
  ownership: {
    creates: [],
    note:
      "A message row is not an owned entity in ADR 9 D3's sense: it belongs to a conversation " +
      'between two mailboxes, and its visibility is already decided by sender-ship and ' +
      'recipient-ship (the mayView arithmetic). It creates no issue and no session.',
  },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: ADDRESS_ORACLE_RULE,
  cli: { positional: ['to'], summary: 'Send agent mail to an issue or a session' },
}

export const mailReplyContract: CommandContract<typeof mailReplyInput> = {
  name: 'mail.reply',
  version: 1,
  visibility: 'personal',
  input: mailReplyInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      "Recipient-ship IS the authorization: a reply routes back to the original's sender, so only " +
      'the party the message was addressed to (or a human principal) may write one. No target ' +
      'scope gate — the destination is not caller-chosen, it is derived from a row the caller has ' +
      'already been authorized to read, which is why no --outside-scope confirmation applies. The ' +
      'human ceiling is satisfied transitively: you cannot reply to a message you could not see.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: DURABLE_QUEUED_ONLINE,
  redaction: NO_SECRETS,
  ownership: {
    creates: [],
    note: 'A reply row, like a send row — see mail.send.',
  },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'The caller supplies a MESSAGE id. A message it may not view must fail as an unknown ' +
      "message id, or the reply path enumerates other principals' traffic.",
  },
  cli: { positional: ['id'], summary: 'Reply to a message you received' },
}

export const spawnAgentContract: CommandContract<typeof spawnAgentInput> = {
  name: 'mail.spawnAgent',
  version: 1,
  visibility: 'personal',
  input: spawnAgentInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'confirm',
    rationale:
      'TWO gates, and the second is the one that is easy to miss. (1) Write access to the target ' +
      'issue, same posture as mail.send — the spawn-on-wake seam sits downstream of the same ' +
      'check, so a spawn has always required write on the target. (2) `use` on the machine the ' +
      'resolved execution profile places the child on. `use` is a CODE-EXECUTION boundary ' +
      "(readiness §3.1.4 M2): it means arbitrary execution on someone's hardware with their SSH " +
      'keys, git identity, dotfiles and checked-out private repos, which is a different blast ' +
      'radius from "can read my issue" and must not read as the same toggle. It is checked against ' +
      "the EFFECTIVE principal — the agent's scope intersected with its human's current rights " +
      '(§3.1.4 M6) — so agents inherit machine grants through the delegation chain and no separate ' +
      'fleet ACL exists to disagree with it. Placement NEVER silently retargets: a denied ' +
      'placement is a denial, because moving the child to a machine the caller may use would run ' +
      'their code somewhere they did not choose.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never enqueued. ADR 3 D4 lists spawn among the archetypal online-only commands: it needs a ' +
      'live daemon on a specific machine, and a queued spawn would be a code-execution grant ' +
      'redeemed against whatever the grant table said at drain time rather than at decision time.',
    applyTimeReauthorization:
      'Live path only, so there is no accept-then-drain gap to re-authorize across. The machine ' +
      '`use` check and the issue write check are evaluated together, at apply, against the ' +
      'effective principal.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The `prompt` is user content and is delivered verbatim. `executionProfileId` names a ' +
      'profile; the credentials the profile resolves to (accountId, machine secrets) are ' +
      'server-side and never appear in the input, the result, or the durable agent.spawned event — ' +
      'the event carries the accountId REFERENCE, which is an id, not material.',
  },
  ownership: {
    creates: ['session', 'issue (only on the deliberate --new path)'],
    owner: 'on-behalf-of-human',
    visibility: 'personal',
    inheritanceOnCreate: 'parent',
    note:
      'ADR 9 D5 A4: both the session and the --new issue are owned by the ON-BEHALF-OF human, ' +
      'with the spawning agent as actor. Otherwise the personal sidebar would not show work your ' +
      'own agent did for you, and retiring an agent session would orphan its issues. ' +
      'INHERITANCE (ADR 9 §3 O4, declared here rather than left to handler code): a child spawned ' +
      "under an issue takes THAT ISSUE's owner and grants, not the actor's — sharing an issue " +
      "shares the work done on it, and a colleague's agent spawning into an issue you shared must " +
      'not produce a session you cannot see. The --new path has no parent issue to inherit from ' +
      'when the caller has no issue scope, and falls back to the on-behalf-of human.',
  },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    // The DELIBERATE opposite of mail.send, and the reason the two rules are
    // recorded per contract instead of once for the vertical.
    distinguishesUnauthorizedFromUnreachable: true,
    note:
      'TWO rules, pulling opposite ways, both intended. The ISSUE address follows D20: beyond the ' +
      'human ceiling fails as nonexistent. The MACHINE follows readiness §3.1.4 M5: unauthorized ' +
      'must stay DISTINGUISHABLE from unreachable, because "denied" and "offline" otherwise ' +
      'produce the same empty list and nobody can tell a permissions problem from a dead machine. ' +
      'Authorization is decided before reachability, so a principal without `use` cannot read the ' +
      "difference between the two errors to probe which of a colleague's machines are online.",
  },
  cli: { summary: 'Spawn a full Podium session as a subagent' },
}

export const awaitAgentContract: CommandContract<typeof awaitAgentInput> = {
  name: 'mail.awaitAgent',
  version: 1,
  visibility: 'personal',
  input: awaitAgentInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'CLASSIFIED AS A WAIT, NOT RECLASSIFIED AS A QUERY — and the acceptance criterion asked for ' +
      'the check, so here is the working. Two facts decide it. (1) It is not pure: on observing a ' +
      'settled child, await RETIRES a notification-fact claim ' +
      '(`sessionparentnudge:phase-reported`) so a later genuine re-completion can wake the parent ' +
      'once more. That is a durable write to notification_facts, so `read` would be a lie about ' +
      'what the command does. (2) The shipped gate already authorizes it with action `write` via ' +
      'the session-target gate, so classifying it `read` would also WIDEN it — a viewer-grade ' +
      'principal would gain the ability to await, which nobody decided. The long-poll semantics ' +
      'are preserved exactly: bounded by timeoutSeconds (max 300), ALWAYS returns, and the ' +
      'parent-relationship shortcut (spawnedBy provenance is sufficient authority to await your ' +
      'own child, across issue scopes, because the crossing was already confirmed at spawn) is ' +
      'kept. It is a wait, and a wait is not a hang.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never enqueued, and the reason is stronger than "it needs a live path": a bounded wait ' +
      'REPLAYED later is meaningless. Its whole result is "what is true within the next N seconds", ' +
      'and N seconds after a drain is a different N seconds. Only acks since waitStart count, so a ' +
      'replayed await would answer about a window that has already closed.',
    applyTimeReauthorization:
      'Live path only; no accept-then-drain gap. Authorization is evaluated once, at apply, and ' +
      'the wait that follows observes only state the caller was already authorized to observe.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The returned snapshot carries session status, phase, need and error — operational state ' +
      'about a session the caller is authorized to await. No credential material, and the ack ' +
      'body it may return is a message the caller is a party to.',
  },
  ownership: {
    creates: [],
    note: 'Awaits an existing session; creates nothing.',
  },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A session id the principal may not see must fail as an unknown session id. Note the ' +
      'shipped `gone` result is NOT that case: `gone` answers about a session the caller was ' +
      'authorized to await and which then vanished, which is an outcome rather than a denial.',
  },
  cli: { positional: ['sessionId'], summary: 'Bounded wait for a child session' },
}

export const mailInboxConsumeContract: CommandContract<typeof mailInboxInput> = {
  name: 'mail.inboxConsume',
  version: 1,
  visibility: 'personal',
  input: mailInboxInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A CONSUMING read, so `write` rather than `read` — reading your own inbox marks its rows ' +
      'read, which is a durable mutation and is why the shipped command is not a query. The ' +
      'arithmetic (D20.1 ratifies it) generalises to the effective principal under multi-user and ' +
      'is otherwise unchanged: your OWN issue box consumes; an in-scope ancestor box is readable ' +
      'unfiltered but never consumed; anything else comes back mayView-FILTERED, so a cross-scope ' +
      'peek returns only rows you sent or received. Evaluated against the effective principal ' +
      "(agent scope intersected with the human's current rights), not against the agent's scope " +
      'alone.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: DURABLE_QUEUED_ONLINE,
  redaction: NO_SECRETS,
  ownership: {
    creates: [],
    note: 'Consumes existing rows; creates nothing.',
  },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'The `issue` argument is caller-supplied, so the FILTERED path is itself an oracle risk: a ' +
      'peek at an invisible issue must return an empty list — the same answer as a peek at an ' +
      'issue with no mail — rather than a distinguishable refusal. Empty and forbidden must look ' +
      'alike here for exactly the reason they must in mail.send.',
  },
  cli: { summary: 'Read (and consume) your mailbox' },
}

/**
 * THE LEDGER RECLASSIFICATION (acceptance criterion 8).
 *
 * `messages.ledger` is operator-only today, and the comment on it says precisely
 * why: it exposes other principals' traffic. That gate was sound while `operator`
 * meant one person; it is not a policy once `operator` is a role everyone who can
 * log in holds. Classified explicitly here rather than left to inherit a
 * now-wrong meaning.
 *
 * It stays a QUERY — it never consumes queued status — so it is `read`, and its
 * exposure classification is the part that changes.
 */
export const mailLedgerContract: CommandContract<typeof mailLedgerInput> = {
  name: 'mail.ledger',
  version: 1,
  visibility: 'personal',
  input: mailLedgerInput,
  policy: {
    action: 'read',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'RECLASSIFIED (readiness §3.2). Was: operator-only, i.e. scope `all`. Now: OWN TRAFFIC for a ' +
      'member, CROSS-USER only at admin grade. A member sees the delivery ledger for traffic they ' +
      'sent or received — which is the "why did my wake not fire" question the view exists to ' +
      'answer, and it is answerable from their own rows. The unfiltered instance-wide projection is ' +
      "the part that exposes other principals' traffic, and it needs admin grade. roleFloor stays " +
      '`member` because a member may legitimately ATTEMPT the command; the grade decides which ROWS ' +
      "come back, which is exactly Amendment 1 D15's split between the role floor and the row gate.",
  },
  // `relay` INCLUDED, corrected in POD-729: the daemon relay's messages arm has
  // always served `ledger` (agents reach it through the relay, not through
  // tRPC), and POD-728's set omitted it. Harmless while the transports were
  // hand-written and every proc fell through the same switch; the moment
  // exposure became DEFAULT-CLOSED and load-bearing it silently removed a
  // shipped agent surface, which is what the gate's own tests caught. Recorded
  // rather than quietly patched, because "the classification was wrong" and
  // "the surface should not exist" are different claims and only the first is
  // true here.
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'A query, so nothing is ever enqueued. Recorded rather than omitted: ADR 3 D3 rule 1 makes ' +
      'an absent classification mean "served nowhere", and this command IS served.',
    applyTimeReauthorization:
      'Evaluated at read time against the effective principal. Under ADR 3 Amendment 1 D19.2 reads ' +
      "are no longer unconditionally allowed, so revoking a member's access takes effect on their " +
      'next read with no cache to invalidate.',
  },
  redaction: NO_SECRETS,
  ownership: {
    creates: [],
    note: 'A pure projection over existing rows.',
  },
  attribution: { ...MAIL_ATTRIBUTION, actor: 'from-capability', onBehalfOf: 'from-delegation' },
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'issueId / sessionId are caller-supplied filters. A ledger query scoped to an invisible ' +
      'issue returns an empty page — identical to an issue with no traffic — never a refusal that ' +
      'would confirm the issue exists.',
  },
  cli: { summary: 'The message delivery ledger' },
}

// ---------------------------------------------------------------------------
// THE REMAINDER (POD-729) — the five procs POD-728 left hand-written
// ---------------------------------------------------------------------------
//
// `show`, `dismiss`, `status`, `pendingReminders` and `ask` were the shipped
// hand-written arm of `MessageGate.dispatch`'s switch. They are classified here
// for the same reason the first six were: a surface that exists twice is the
// intermediate state POD-279 exists to end, and the switch could not be DELETED
// while five procs still needed it. `ask` is the one of the five that reaches
// message DELIVERY, which is why leaving it behind would have left a live
// send path that no contract policy governs.

/** The oracle rule for the three commands addressed by MESSAGE id. One constant:
 *  three surfaces answering "unknown message" three ways is how a projection
 *  becomes an enumeration tool. */
const MESSAGE_ID_ORACLE_RULE: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'The caller supplies a MESSAGE id. A row it may not view must be indistinguishable from a row ' +
    "that does not exist, or the projection surfaces enumerate other principals' traffic one id at " +
    'a time. Note what this does NOT yet hold: the shipped refusal for an existing-but-invisible ' +
    'row is a distinct string from the unknown-id refusal, and POD-727 pinned both. Collapsing ' +
    'them is a behaviour change to a pinned oracle and belongs to the issue that owns the ' +
    'projection surfaces, not to this cutover — recorded here so the gap is in the contract rather ' +
    'than only in a reviewer’s memory.',
}

export const mailShowInput = z.object({ id: z.string() })
export const mailDismissInput = z.object({ id: z.string() })
export const mailStatusInput = z.object({ id: z.string() })
export const mailPendingRemindersInput = z.object({}).optional()
export const mailAskInput = z.object({
  sessionId: SessionIdField,
  question: z.string().min(1).max(32_768),
  timeoutSeconds: z.number().min(0).max(300).optional(),
})

export const mailShowContract: CommandContract<typeof mailShowInput> = {
  name: 'mail.show',
  version: 1,
  visibility: 'personal',
  input: mailShowInput,
  policy: {
    action: 'read',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A pure projection of ONE row, gated by the same `mayView` arithmetic as the ledger: you may ' +
      'read a message you sent or received, never a stranger’s. `resource: none` because the row is ' +
      'not an owned entity — visibility follows sender-ship and recipient-ship, which is the ' +
      'mailbox conversation model, not an issue-scope question.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'A query, so nothing is ever enqueued. Recorded rather than omitted: ADR 3 D3 rule 1 makes an ' +
      'absent classification mean "served nowhere", and this command IS served.',
    applyTimeReauthorization:
      'Evaluated at read time against the effective principal; no accept-then-drain gap exists for a ' +
      'read, so a revoked principal is refused on its next call with nothing to invalidate.',
  },
  redaction: NO_SECRETS,
  ownership: { creates: [], note: 'A projection over one existing row.' },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: MESSAGE_ID_ORACLE_RULE,
  cli: { positional: ['id'], summary: 'Show one message' },
}

export const mailDismissContract: CommandContract<typeof mailDismissInput> = {
  name: 'mail.dismiss',
  version: 1,
  visibility: 'personal',
  input: mailDismissInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'RECIPIENT-SHIP IS THE AUTHORIZATION, and it is STRICTER than `show`. Dismiss is a durable ' +
      'write that clears the row from a mailbox, so being able to SEE a message is not enough — the ' +
      'sender may read what it sent (mayView) but may not dismiss it out of the recipient’s box. ' +
      'That is why the shipped check is `isRecipient` and not `mayView`, and the difference is ' +
      'recorded here so a future author does not "simplify" the two into one predicate.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: DURABLE_QUEUED_ONLINE,
  redaction: NO_SECRETS,
  ownership: { creates: [], note: 'Mutates an existing row; creates nothing.' },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: MESSAGE_ID_ORACLE_RULE,
  cli: { positional: ['id'], summary: 'Dismiss a message from your inbox' },
}

export const mailStatusContract: CommandContract<typeof mailStatusInput> = {
  name: 'mail.status',
  version: 1,
  visibility: 'personal',
  input: mailStatusInput,
  policy: {
    action: 'read',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'The sender-queryable lifecycle [POD-834 §04d]: "what happened to msg X" after a synchronous ' +
      'send returned at queued. Same `mayView` gate as `show` — sender, recipient or admin — which ' +
      'is what makes it answerable by the SENDER and not merely by the recipient. Deliberately NOT ' +
      'operator-only: the question it answers is about your own traffic.',
  },
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation: 'A query; nothing is enqueued. Stated rather than defaulted (D3 rule 1).',
    applyTimeReauthorization: 'Evaluated at read time against the effective principal.',
  },
  redaction: NO_SECRETS,
  ownership: { creates: [], note: 'A projection over one existing row.' },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: MESSAGE_ID_ORACLE_RULE,
  cli: { positional: ['id'], summary: 'What happened to a message you sent' },
}

export const mailPendingRemindersContract: CommandContract<typeof mailPendingRemindersInput> = {
  name: 'mail.pendingReminders',
  version: 1,
  visibility: 'personal',
  input: mailPendingRemindersInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A CONSUMING read of the CALLER’S OWN box, so `write` — returning a reminder marks it ' +
      'reminded, which is the durable state that stops the stop-hook nagging twice for one message. ' +
      'There is no caller-supplied target: the mailbox is `capability.actorSessionId`, so the ' +
      'command is unaddressable by construction and a principal with no session gets an empty list ' +
      'rather than a refusal.',
  },
  exposure: ['relay'],
  delivery: DURABLE_QUEUED_ONLINE,
  redaction: NO_SECRETS,
  ownership: { creates: [], note: 'Marks existing rows reminded; creates nothing.' },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'No target id on the wire at all — the mailbox comes from the capability. There is nothing ' +
      'for a caller to probe, which is the strongest form of D20 compliance available.',
  },
  cli: { summary: 'The stop-hook’s unacked-message reminder' },
}

export const mailAskContract: CommandContract<typeof mailAskInput> = {
  name: 'mail.ask',
  version: 1,
  visibility: 'personal',
  input: mailAskInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'THE SEANCE IS A MESSAGE, and classifying it as anything else is how it would acquire a second ' +
      'policy. `podium session ask` sends a `kind:"question"` row at next-turn + wake and waits, ' +
      'bounded, for the ack — so it rides the send pipeline and the clamp matrix, wake cooldown and ' +
      'hop brake all apply unchanged. `write` on the target SESSION, via the same session-target ' +
      'gate `mail.send` uses: a question costs a turn of the target’s quota, so it is a real act on ' +
      'that session and never a read. No `--outside-scope` confirmation because the shipped gate ' +
      'never asked for one and D20.1 ratifies rather than redesigns; the human ceiling still bounds ' +
      'which sessions are addressable at all.',
  },
  // `sessions.ask` on tRPC and on the relay — the wire name stays under the
  // sessions router (that is where the CLI calls it), and this contract is what
  // that procedure dispatches. `exposure` records the transports, not the router.
  exposure: ['trpc', 'cli', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never enqueued, for `mail.awaitAgent`’s reason rather than `mail.send`’s: the command CONTAINS ' +
      'a bounded wait, and a wait replayed later answers about a window that has already closed.',
    applyTimeReauthorization:
      'Live path only; no accept-then-drain gap. The question row itself is an ordinary message and ' +
      'is re-authorized at delivery like any other (see mail.send).',
  },
  redaction: NO_SECRETS,
  ownership: { creates: [], note: 'Sends a question row; creates no issue and no session.' },
  attribution: MAIL_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A session id the principal may not see must fail as an unknown session id, exactly as it does ' +
      'for a session-addressed mail.send — the two go through the same gate, so there is one answer.',
  },
  cli: { positional: ['sessionId'], summary: 'Ask a session a question and wait for the answer' },
}

/** The agent-mail contract table. POD-729 derives the transports from it and
 *  deletes the hand-written procs. */
export const MAIL_CONTRACTS = [
  mailSendContract,
  mailReplyContract,
  spawnAgentContract,
  awaitAgentContract,
  mailInboxConsumeContract,
  mailLedgerContract,
  mailShowContract,
  mailDismissContract,
  mailStatusContract,
  mailPendingRemindersContract,
  mailAskContract,
] as const

export type MailContractName = (typeof MAIL_CONTRACTS)[number]['name']
