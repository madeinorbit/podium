/**
 * THE SHARED POLICY CELLS FOR THE SIXTY-EIGHT ISSUE COMMAND CONTRACTS (POD-311).
 *
 * Split out of `contracts.ts` so the table beside them reads as a table: sixty-eight
 * commands fall into SIX classes, and a class's reasoning is written ONCE here rather
 * than sixty-eight times next to sixty-eight names. The workflows tenant writes each
 * of its eleven contracts out in full and that is right at eleven; at sixty-eight the
 * same style produces four thousand lines in which the one contract that differs is
 * invisible. So the rule this file follows is: a cell is shared when the reasoning is
 * literally the same sentence, and a contract that deviates writes its own cell inline
 * and says why (see `mailClaim`, `linearSearch`, `create`, `subscriptionAdd`).
 *
 * L1 RULE (contract.ts's header): pure data and pure functions over `@podium/model`
 * and `@podium/protocol`. No handler, no service, no IO. The issue handlers stay in
 * `apps/server/src/modules/issues/registry.ts` and are joined to these contracts
 * there — POD-311 finding 1's downward-dependency rule.
 */

import type {
  AttributionPolicy,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

// ---------------------------------------------------------------------------
// D3 — exposure, and the ONE distinction that is real for this surface
// ---------------------------------------------------------------------------

/**
 * WHAT ACTUALLY SERVES AN ISSUE COMMAND TODAY, measured rather than assumed.
 *
 * Two server-side arms serve every one of the sixty-eight: the derived tRPC
 * sub-router (`modules/issues/trpc.ts`) and the daemon relay's dispatch
 * (`IssueCommandDispatcher.dispatch`). A THIRD and FOURTH — the `podium issue` CLI
 * and the in-process MCP tool surface — serve only what `@podium/issue-client`'s
 * table reaches, and that is 59 of the 68, because those two surfaces are the SAME
 * table: `apps/server/src/issue-mcp.ts` derives its tools from `ISSUE_COMMANDS`,
 * the very table the CLI renders. They are therefore one exposure decision, not two.
 *
 * The nine that no CLI verb and no MCP tool reaches are web-UI-only:
 * `applySuggestion` · `dismissSuggestion` · `refreshAssistant` (the assistant panel),
 * `markRead` · `markUnread` · `setTucked` (per-user list state), `closeEligibleEpics`,
 * `linearSearch` and `subscriptionSetEnabled`. Declaring `cli`/`mcp` on those would
 * not open them — nothing dispatches them there — but it would make the field a
 * decoration, and ADR 3 D3's whole content is that a transport is served because a
 * contract NAMES it. So the field says what ships, and `audit-issue-commands.ts`
 * checks the declaration against the CLI table's actual reach in BOTH directions:
 * a proc the table reaches without the tag, and a tag without a reaching proc, are
 * both findings.
 */
export const SERVED_EVERYWHERE: readonly TransportTag[] = ['trpc', 'relay', 'cli', 'mcp']

/** The two server-side arms alone — see {@link SERVED_EVERYWHERE} for the nine
 *  commands no CLI verb and no MCP tool reaches. */
export const SERVED_ON_WIRE: readonly TransportTag[] = ['trpc', 'relay']

// ---------------------------------------------------------------------------
// ADR 9 D3/D4 — visibility, read off ADR 1's matrix and not chosen here
// ---------------------------------------------------------------------------

/**
 * Every issue row on ADR 1's ownership matrix — `issueCore`, `issueDocumentFields`,
 * `needsHuman`, `issueGraph`, `issueComments`, `issueMessages`, `artifacts` — is
 * `personal`. That is a MEASUREMENT of the matrix, not a default applied here, and
 * `contracts.test.ts` asserts it against `visibilityClassOf()` per row so a
 * reclassification by POD-1071 turns these contracts red instead of leaving them
 * quietly disagreeing with the row they mirror.
 */
export const ISSUE_VISIBILITY: VisibilityClass = 'personal'

/**
 * THE ONE ISSUE ROW THAT IS NOT `personal`, and the reason four commands are their
 * own class.
 *
 * ADR 1 declares `issueMessageReadAt` — `issue_messages.read_at` and `issues.read_at`
 * — via `perUserState(...)`, i.e. ADR 9 D3's `per-user-state`: keyed `(userId,
 * entityId)`, never shared, NON-GRANTABLE (D3 rule 4 — there is no "share my read
 * state" verb). `markRead`, `markUnread`, `setTucked` and the consuming arm of
 * `mailInbox` write exactly that state.
 *
 * WHAT THIS DECLARATION DOES NOT DO IS FIX IT. The columns are SINGLETONS today —
 * one `read_at` for the whole instance, not one per user — which is the
 * `per-user-singletons` ratchet's territory (8 sites, POD-302's) and the matrix's own
 * `conflictNote` says so in as many words: "Two more SINGLETON `read_at` columns
 * today; the same re-key as the session one." Re-keying them is a schema change and a
 * behaviour change, and this issue is a migration with neither. So the contract states
 * the CLASS truthfully and the defect stays where it is already counted. Classifying
 * these as `personal` to match the neighbouring sixty-four would have been the silent
 * option, and it would have taught the next author that a read marker is shared state.
 */
export const PER_USER_VISIBILITY: VisibilityClass = 'per-user-state'

// ---------------------------------------------------------------------------
// ADR 3 D8 / Amendment 1 D16 — apply-time re-authorization
// ---------------------------------------------------------------------------

/**
 * One sentence on every contract because it is one rule. The half that is easy to
 * leave out is what the SENDER is told: a capability that no longer resolves must
 * deny the way an unknown id denies, or the refusal itself reports that the issue
 * exists.
 */
export const REAUTHORIZATION =
  'Re-authorized at every apply against the capability resolved LIVE, never one frozen at enqueue: ' +
  '`guardIssueCommand` runs the role gate and the subtree gate on the RAW input before the schema ' +
  'is parsed and before the handler is entered, on the tRPC path and the relay/MCP path alike, from ' +
  'the one shared implementation. A subtree that has moved under the caller’s feet — `reparent` is ' +
  'the mover ADR 1 flags — is re-read at that moment. The denial for an issue the caller may not ' +
  'see is the same NOT_FOUND an unknown id gets (Amendment 1 D20.2), so the refusal is not itself ' +
  'an existence oracle.'

// ---------------------------------------------------------------------------
// D4 — delivery classes
// ---------------------------------------------------------------------------

/**
 * ISSUE WRITES ARE `offline-eligible`, AND THAT IS READ OFF THE MATRIX RATHER THAN
 * JUDGED HERE: ADR 1's `issueCore` row carries `offline: 'offline-eligible'`.
 *
 * The class is a statement about the command's SHAPE; `exposure` is a statement about
 * what is wired, and NOTHING here names `outbox`. No client outbox path exists for
 * issues — POD-379's oracle covers the session presence family and tags that set
 * must-not-change — so declaring the tag would open a transport nothing serves. ADR 3
 * D3 rule 2 permits the tag only for this class; permission is not wiring.
 *
 * THE DURABILITY THAT DOES EXIST IS A DIFFERENT OBJECT, and confusing the two is the
 * exact mistake ADR 3 D4 rule 4 was written to prevent. `IssueCommandCtx.issueWrite`
 * forwards a mutation whose target is a hub-mirrored issue to the upstream forwarder
 * and answers `{ queued: true }` when the hub is unreachable. That is a SERVER-side
 * queue for an already-authorized online command — D4 rule 4's "delivery mechanism",
 * not a client Outbox class — and it is re-authorized on arrival at the hub, which
 * runs this same registry.
 */
export const WRITE_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'ADR 1’s `issueCore` row declares `offline: offline-eligible`, and idempotency is framework-owned ' +
    '(`MutationLedgerPort.once`, keyed by the caller’s `mutationId` and the wire name), which is the ' +
    'property a replay needs. NOT exposed on `outbox`: no client outbox path exists for issues and ' +
    'POD-379’s oracle pins the covered set to the session presence family. The `{ queued: true }` the ' +
    'viaHub forwarder can return is ADR 3 D4 rule 4’s server-held delivery queue for an ALREADY ' +
    'AUTHORIZED online command, re-authorized by the hub against this same registry — a different ' +
    'durability from the client Outbox, and deliberately not reconciled with it here.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * A READ IS `online-only` BECAUSE THERE IS NOTHING TO REPLAY. The three-member class
 * vocabulary has no "not applicable", and the honest member is the one that says a
 * live authority is required: an issue list answered from a queue would be an answer
 * about the past presented as an answer about now. Reads are not enqueued anywhere
 * today and this records that rather than leaving the strongest-sounding member
 * (`offline-eligible`) to be inherited by whoever copies a read contract next.
 */
export const READ_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'Never queued: a read has no effect to replay, and an answer served from a queue would describe ' +
    'the world as it was while claiming to describe it as it is. Nothing enqueues a read today and ' +
    'no transport here names `outbox`.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * D3 for the four per-user commands — `markRead`, `markUnread`, `setTucked` and
 * `mailInbox`'s consuming arm.
 *
 * OFFLINE-ELIGIBLE, and this is the FLIP POD-311 wrote its tripwire to force.
 *
 * It was `online-only`, for one reason recorded on this cell: the rows these
 * commands wrote were SINGLETON columns (`issues.read_at`, `issues.tucked_at`,
 * `issues.pinned`, `issue_messages.read_at`), so a queued write replayed at drain
 * time applied one principal's marker to EVERY reader. That is not a property of
 * the command; it is a property of a table with no user in its key.
 *
 * POD-1076 put the user in the key. A drained write now lands on the actor's own
 * `(userId, entityId)` row and cannot reach anybody else's, so the queue is safe
 * and these four match their SESSION twins — two of POD-379's seven offline-eligible
 * writes are exactly `markRead`/`markUnread` on a session, and having the same act
 * queue on one entity and refuse on another was always an artefact rather than a
 * decision.
 *
 * Marking read is also the ideal queued write on its own merits: idempotent, and
 * last-write-wins against a key only its owner writes, which is `single-writer` by
 * construction (ADR 1's per-user-state row).
 */
export const PER_USER_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'QUEUED. Each command writes ONE `(userId, entityId)` row that only its owner writes, so a ' +
    'drained write is single-writer by construction and cannot apply one principal\u2019s marker to ' +
    'another reader \u2014 the exact hazard that kept this class `online-only` while the markers were ' +
    'singleton columns (POD-311\u2019s recorded expiry condition, cleared by POD-1076\u2019s re-key). ' +
    'Reconciliation is last-write-wins on the drained timestamp: replaying a stale `markRead` behind ' +
    'a newer one costs the owner a re-read marker and nothing else, and `markUnread` DELETES the row ' +
    'rather than writing a null, so a replayed pair converges on the same state in either order.',
  applyTimeReauthorization: REAUTHORIZATION,
}

// ---------------------------------------------------------------------------
// D5 — redaction
// ---------------------------------------------------------------------------

/**
 * Reviewed and empty, for the whole surface. Issue titles, descriptions, briefs,
 * comments and mail bodies are author-written prose that anyone who may see the issue
 * may already read, so redacting them would hide the row's content from its own
 * readers rather than protect anything. There is no credential, token or key on any
 * of the sixty-eight inputs — checked, not assumed: `contracts.test.ts` walks every
 * input schema's key set for the credential-shaped names.
 *
 * `repoPath` and the artifact `path`/`extraPaths` are filesystem paths and are the
 * closest call. They are NOT redacted: a repo path is the addressing vocabulary the
 * whole CLI speaks (`--repo`), it is echoed back in every list result, and hiding it
 * from a log while printing it in the output would be theatre.
 */
export const ISSUE_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Nothing on this surface is a credential. Issue prose, comments and mail bodies are readable by ' +
    'anyone who may read the issue, so redacting them would hide content from its own audience. ' +
    '`repoPath` and artifact paths are addressing, echoed in every result, and printed by the CLI.',
}

// ---------------------------------------------------------------------------
// Amendment 1 D17 — attribution is a PAIR, and it is stamped, never accepted
// ---------------------------------------------------------------------------

/**
 * The one cell for all sixty-eight, and it is the surface's strongest existing
 * property rather than an aspiration: `IssueCommandCtx` derives `mailIdentity()`,
 * `messageSender()` and `spawnProvenance()` from `caller.capability` alone, and both
 * `issues.create` and `issues.attachSession` carry an explicit comment that `origin`
 * is NOT an accepted input precisely so provenance cannot be forged.
 *
 * `wirePlacement: 'separate-field'`. The alternative — folding the human into
 * `assignee` or `author` — is the substitution D17 forbids: `addComment` already
 * takes a caller-supplied `author` STRING, which is display text and not an identity,
 * and letting it double as the accountability record would make "did a person or an
 * agent write this?" unanswerable.
 *
 * POD-364's inventory finding is recorded on ADR 1's `issueCore` row and is NOT
 * resolved here: the issue CLOSE actor is stored nowhere at all. This contract
 * declares what the transport stamps; the column that would persist it is POD-1075's.
 */
export const ISSUE_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves are stamped from the transport principal and never read from payload — the shipped ' +
    'rule, kept: `mailIdentity`, `messageSender` and `spawnProvenance` all read `caller.capability`, ' +
    'and `create`/`attachSession` refuse a caller-supplied `origin` for exactly this reason. Reserved ' +
    'as separate keys because `addComment.author` is DISPLAY TEXT: folding the pair into it would ' +
    'answer "who acted" with a string the caller chose. POD-364’s finding that the close actor is ' +
    'persisted nowhere stays open on ADR 1’s `issueCore` row — this declares the wire, not the column.',
}

// ---------------------------------------------------------------------------
// Amendment 1 D20 — the consistent-error rule
// ---------------------------------------------------------------------------

/**
 * For every command taking a caller-supplied id naming an existing issue, message or
 * subscription. `checkIssueAccess` is the one implementation and it already answers
 * NOT_FOUND for an issue outside the caller's subtree, which is D20.2's requirement.
 *
 * `distinguishesUnauthorizedFromUnreachable: false` — no issue command places code on
 * owned compute, so readiness §3.1.4 M5's carve-out does not apply. `issues.start`,
 * `addSession` and `addShell` LOOK like they might: they spawn sessions. They spawn
 * them by handing the request to the sessions feature, whose own `use` contracts take
 * that decision (`packages/commands/src/sessions/`), which is where the M5 carve-out
 * lives. Declaring `use` here would put the code-execution check on the wrong side of
 * the boundary and would say that filing an issue is the dangerous act.
 */
export const TARGETED_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'An issue the caller may not see fails as NOT_FOUND, identically to an id that does not exist — ' +
    '`checkIssueAccess` is the single implementation and already does this. No machine carve-out: no ' +
    'issue command places code on owned compute. `start`/`addSession`/`addShell` spawn sessions by ' +
    'delegating to the sessions feature, whose own `use` contracts take the readiness §3.1.4 M5 ' +
    'decision — putting it here would check the execution boundary on the wrong side of it.',
}

/** For the commands whose whole input is a repo path, a filter or nothing at all —
 *  there is no target id to turn into an oracle. Written out rather than omitted,
 *  because "this command cannot leak existence" and "nobody asked" must not look
 *  alike (the same reason `SERVED_NOWHERE` is a named constant). */
export const UNTARGETED_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'No caller-supplied target id: the input is a repo path, a filter, a cursor or nothing. `repoPath` ' +
    'is caller-supplied but names a repo the caller is already working in, and an unregistered path ' +
    'yields an empty result rather than a refusal — so there is no existence signal to converge.',
}

// ---------------------------------------------------------------------------
// ADR 9 D5 A4 — what a command creates, and who owns it
// ---------------------------------------------------------------------------

/** The commands that mint nothing. Most of the sixty-eight: a read, or a write that
 *  moves an existing row. Stated, never omitted — `classificationErrors` requires the
 *  note either way. */
export const CREATES_NOTHING: CreationOwnership = {
  creates: [],
  note: 'Moves or reads existing rows; mints no entity, so there is no owner to assign.',
}

/** ADR 9 D5 A4 + readiness §3.1.2, per creating command. `inheritance` is `parent`
 *  when the new row hangs off an issue that already has an owner, and
 *  `on-behalf-of-human` when there is no parent to inherit from. */
export const owns = (
  creates: readonly string[],
  inheritanceOnCreate: 'parent' | 'on-behalf-of-human',
  note: string,
): CreationOwnership => ({
  creates,
  owner: 'on-behalf-of-human',
  visibility: ISSUE_VISIBILITY,
  inheritanceOnCreate,
  note,
})

// ---------------------------------------------------------------------------
// D2 — the five policy cells
// ---------------------------------------------------------------------------

/**
 * WHY EVERY CELL BELOW SAYS `roleFloor: 'member'`, INCLUDING THE MANAGE ONE.
 *
 * `roleFloor` is Amendment 1 D15's ACCOUNT GRADE — a floor on which commands a
 * principal may ATTEMPT, decided by what kind of account they hold. Podium has no
 * account grades: POD-1075 has not landed, there is one shared password, and
 * `client_sessions` has no user column. Declaring `admin` on any of the sixty-eight
 * would name a gate no transport can evaluate, and the enforcement point would then
 * either ignore it (a decoration) or invent an answer (a fabricated identity). ADR 9
 * D5 A1's live-evaluation rule cuts the same way: a floor that cannot be resolved at
 * apply time is not a floor.
 *
 * The gate that DOES exist is `policy.action` against the caller's capability scope,
 * which is `IssueAction`'s viewer/worker/admin ladder — the operator holds scope
 * `all`, an agent holds `subtree`. That ladder is carried faithfully: `manage`
 * commands are operator-only today and stay operator-only, and that fact rides
 * `action`, which is where the shipped code already reads it.
 */
const ROLE_FLOOR_RATIONALE =
  'Role floor `member` throughout: POD-1075 has not landed, so there are no account grades to floor ' +
  'against — one shared password, no user column on `client_sessions`. The gate that exists is ' +
  '`action` against the caller’s capability scope (operator = `all`, agent = `subtree`), which is ' +
  'where the shipped `checkIssueAccess` already reads it. An `admin` floor here would name a grade ' +
  'no transport can authenticate.'

/**
 * READS ARE NEVER SUBTREE-GATED TODAY, and `resource: 'none'` is the faithful way to
 * say so rather than a shrug.
 *
 * ADR 3 D2's `none` is documented as the additive / self-addressed case — "must be
 * WRITTEN, never reached by omitting the field" — and the shipped registry reaches the
 * same state by omitting `scope`, whose own doc says an omitted scope means "role-gated
 * only, exactly like a PROC_ACTION entry without a SCOPED_TARGET extractor". So this is
 * a transcription of the shipped rule, not a new decision.
 *
 * IT IS ALSO A RECORDED GAP. `issues.get`, `tree`, `comments` and `epicStatus` take a
 * caller-supplied id and are NOT subtree-gated: any authenticated caller may read any
 * issue. That is today's behaviour and this migration keeps it. Narrowing it is a
 * product change and belongs to POD-1071's visibility work, where the matrix's
 * `visibilityMutability` row already lists the verbs that would move a subtree.
 */
export const READ_POLICY = {
  action: 'read',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'Role-gated only, never subtree-gated — the shipped rule, transcribed: the registry’s reads omit ' +
    '`scope`, and an omitted scope means no per-target gate. RECORDED GAP, deliberately unchanged: ' +
    '`get`/`tree`/`comments`/`epicStatus` take a caller-supplied id and any authenticated caller may ' +
    'read any issue. Narrowing that is POD-1071’s visibility work, not this migration. ' +
    ROLE_FLOOR_RATIONALE,
} as const

/**
 * The per-user cell. `action: 'read'` is not a typo and not a weakening: marking your
 * own copy of an issue read is a read-grade act on the issue and a write only to your
 * own row, which is precisely ADR 9 D3 rule 4's non-grantable per-user class. The
 * shipped registry already declares these four `action: 'read'` with `kind: 'mutation'`.
 */
export const PER_USER_POLICY = {
  action: 'read',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'Read-grade on the issue, write-grade on the principal’s OWN row — ADR 9 D3 rule 4’s non-grantable ' +
    'per-user class, and the shipped declaration (`action: read`, `kind: mutation`) already says it. ' +
    'There is no subtree gate because there is no shared row to gate. See `PER_USER_VISIBILITY` for ' +
    'the singleton-storage divergence this class currently overstates, and the tripwire that pins it. ' +
    ROLE_FLOOR_RATIONALE,
} as const

/** The subtree-gated write cell — 29 commands that mutate an EXISTING issue.
 *  `confirmation: 'confirm'` is `--outside-scope` / `overrideScope`: an agent writing
 *  outside its subtree is not refused, it is asked to confirm knowingly (D2's escape,
 *  and the shipped `PRECONDITION_FAILED` re-run message). */
export const WRITE_POLICY = {
  action: 'write',
  roleFloor: 'member',
  resource: 'issue',
  confirmation: 'confirm',
  rationale:
    'Mutates an EXISTING issue, so the subtree gate runs on the raw input before parsing: an agent ' +
    'writing inside its subtree proceeds, one writing outside it gets PRECONDITION_FAILED and may ' +
    're-run with `--outside-scope` (D2’s deliberate-widening escape, `overrideScope` on the wire). ' +
    'The operator’s scope `all` short-circuits the target check — which is exactly the arm POD-351 ' +
    'showed a suite can hide behind, so `registry.test.ts` exercises these as a SUBTREE agent. ' +
    ROLE_FLOOR_RATIONALE,
} as const

/** `manage` — delete, restore, setLabels. Operator-only in practice, because `manage`
 *  sits above `worker` on `IssueAction`'s ladder and an agent capability is a worker.
 *  The action carries that; the role floor cannot (see {@link READ_POLICY}). */
export const MANAGE_POLICY = {
  action: 'manage',
  roleFloor: 'member',
  resource: 'issue',
  confirmation: 'confirm',
  rationale:
    'Tombstoning an issue, restoring one, and rewriting its whole label set are `manage` on ' +
    '`IssueAction`’s viewer/worker/admin ladder — above the worker grade an agent capability holds, ' +
    'so operator-only in practice. That gate rides `action`, unchanged from the shipped table. ' +
    ROLE_FLOOR_RATIONALE,
} as const

/** Additive / self-addressed: no existing issue to gate against, so no subtree check
 *  and no confirmation. ADR 3 D2 names `mailSend` as the archetype of this
 *  non-entry, and the shipped registry omits `scope` on exactly this set. */
export const ADDITIVE_POLICY = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'Additive or self-addressed: creates a row, addresses the caller’s own mailbox, or manages the ' +
    'caller’s own subscriptions. There is no existing issue to scope against, which is ADR 3 D2’s ' +
    'documented non-entry (it names `mailSend` as the archetype) and the shipped registry’s own ' +
    'omission of `scope` on this set. The in-handler ownership checks the subscription commands run ' +
    '(`deriveSubscriber`, the own-subscription test) are L3 and stay with the handler. ' +
    ROLE_FLOOR_RATIONALE,
} as const
