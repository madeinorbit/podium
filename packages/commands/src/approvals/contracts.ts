/**
 * THE TWO APPROVAL DECISION CONTRACTS — `approvals.approve · approvals.deny`.
 *
 * The operator half of the approval broker ([spec:SP-edbb], #410). The AGENT half
 * — `request` and `get` — is deliberately not here: it rides the issue relay and
 * has never been a tRPC procedure, so contracting it would be POD-314 declaring a
 * transport surface that does not exist. ADR 3 D3 is default-closed in both
 * directions; a tag that opens nothing is a decoration, and POD-386 made the same
 * call about `mcp` for specs after MEASURING reach rather than assuming it.
 *
 * L1 DATA ONLY. The handler is `ApprovalService.approve` / `.deny` in
 * `apps/server/src/modules/approvals/service.ts`, UNCHANGED by this issue: what
 * moves here is the input vocabulary and the classification, joined at the service
 * by `modules/approvals/registry.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE CLASSIFICATION, READ OFF THE MATRIX AND NOT OFF A NEIGHBOUR
 * ---------------------------------------------------------------------------
 *
 * `personal`, from ADR 1's `approvals` row, and the reasoning matters because
 * `personal` is also what the ADR 9 D4 backstop returns for a row NOBODY
 * classified — the trap POD-386 and the coordinator both named. This value is a
 * declaration: the row exists, it says `visibility: 'personal'`, and it says why —
 * the owner is `routed-to-human`, "the human the request is ROUTED TO", because
 * attention routing is per-user by construction (ADR 9 D8 S3). An approval is not
 * personal because nobody thought about it; it is personal because it is addressed
 * to one person's attention.
 *
 * NOT `per-user-state`, which is the neighbouring value and the one POD-351's trap
 * would have produced. Per-user-state is the readAt / snooze / pins shape: the SAME
 * shared entity carrying a different fact per viewer. An approval request is one
 * durable row with one routed-to owner, not a per-viewer projection of a shared
 * one. Getting this backwards would key a single shared decision as a private one
 * per reader, and two operators would each see their own copy of a queue that must
 * have exactly one answer.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH ARE `manage` AND NOT `write`
 * ---------------------------------------------------------------------------
 *
 * This is the fork this file had to resolve and it is worth stating. An approval
 * decision does not edit the approval — it AUTHORIZES SOMETHING ELSE TO HAPPEN.
 * `ApprovalService.approve` executes the pending op through the closed server
 * catalog or hands it to the daemon; the row transition is the receipt, not the
 * effect. ADR 3 D2 grades by what the command lets happen, so a decision that
 * releases an operation the requester could not perform alone is `manage`, and
 * grading it `write` would make "may edit a row" and "may release a held
 * operation" the same permission.
 *
 * `roleFloor` stays `member` and the two are not in tension: the floor says which
 * commands a principal may ATTEMPT, the action says which rows it may TOUCH
 * (Amendment 1 D15, and D15.2's rule that neither check substitutes for the
 * other). The routed-to human is frequently an ordinary member, and an admin floor
 * would lock them out of their own queue.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

// ---------------------------------------------------------------------------
// Shared cells, so a repeated rule cannot drift between the two.
// ---------------------------------------------------------------------------

/**
 * `trpc` ALONE, and the emptiness of the rest of the set is the claim.
 *
 * Measured, not assumed: the shipped `approvals` router serves `list`, `approve`
 * and `deny` and nothing reaches them but the web operator surface. The agent
 * side (`request`, `get`) goes through the issue relay's own arm and is a
 * different pair of procedures on a different transport — which is exactly why it
 * is not in this table. No `cli` verb and no MCP tool names either of these.
 */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/** ADR 1's `approvals` row. Read the header before copying this: `personal` here
 *  is a declaration off the matrix, not the D4 backstop firing. */
const APPROVAL_VISIBILITY: VisibilityClass = 'personal'

/**
 * ONLINE-ONLY, transcribed from the matrix row's `offline: 'online-only'` rather
 * than chosen — and the reason it must not be queued is sharper than the row.
 *
 * An approval is a HELD OPERATION with a requester waiting on it. A queued
 * decision replayed after a drain window has two failure modes and both are bad:
 * the op it releases may no longer be the op the operator read (the session moved,
 * the machine went away), and the requester has meanwhile been told nothing. The
 * broker exists precisely so that a risky operation waits for a live human answer;
 * a durable queue would reintroduce the delay the broker was built to make
 * visible.
 */
const APPROVAL_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued, and the matrix row says so independently (`offline: "online-only"`). A decision ' +
    'RELEASES a held operation, so replaying one after a drain window can authorize an op that no ' +
    'longer means what the operator read — a different session placement, a machine that has since ' +
    'gone. ADR 3 D4 rule 4 is also live here: the relay’s durable agent queue carries the REQUEST ' +
    'side, and that is a delivery mechanism for an already-authorized online command, not an ' +
    'Outbox offline class for the decision.',
  applyTimeReauthorization:
    'Re-authorized live at apply against the delegation resolved at that moment (ADR 9 D5 A1), never ' +
    'a capability frozen when the request was raised. A principal who has lost the grade between ' +
    'seeing the queue and clicking is refused, and the row stays pending rather than silently ' +
    'terminal — the requester is told nothing changed, which is the honest answer.',
}

/**
 * Reviewed, and the answer is that the decision itself carries nothing sensitive —
 * with the one path that had to be considered named, so the empty list reads as a
 * finding rather than as a default.
 *
 * The candidate is the approval PAYLOAD, which can describe a command about to be
 * run on a machine. It is not redacted HERE because it does not cross this
 * surface: `approve`/`deny` carry an opaque server-minted `id` and nothing else,
 * and the payload travels on the `list` read and the request side. The matrix row
 * agrees and points at the same owner — `secret: 'public'`, with the note "Payload
 * redaction is ADR 3's" — which is a statement about the REQUEST contract, not
 * about these two.
 */
const APPROVAL_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'The decision commands carry a server-minted opaque `id` and nothing else — no payload, no ' +
    'credential, no machine identity. The one candidate, the pending op’s payload, does not cross ' +
    'THIS surface: it rides the `list` read and the agent-side request. The matrix row’s ' +
    '`secretNote` assigns that redaction to ADR 3, and it belongs to the request contract, which ' +
    'this table deliberately does not own.',
}

/**
 * ADR 9 D5 A3 / Amendment 1 D17 — both halves stamped from the transport
 * principal, never from payload, and the matrix row requires both
 * (`attribution: { actor: 'required', onBehalfOf: 'required' }`).
 *
 * WHO DECIDED is the entire product value of an approval record. The row is
 * `never-delete` with terminal states retained precisely so that "this was
 * approved, by whom, at what grade" survives; folding either half into the `id` —
 * the only other field on the wire — is the substitution D17 forbids, and it would
 * make the audit trail unreadable at exactly the moment anyone needs it.
 */
const APPROVAL_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal. WHO DECIDED is the durable point of an approval ' +
    'record — the matrix keeps terminal rows forever so the answer survives — and the pair must be ' +
    'stamped rather than claimed, or an agent could record a human’s decision. `id` is a routing ' +
    'address and Amendment 1 D17 forbids an address doubling as the accountability record.',
}

/**
 * Amendment 1 D20.3, and this family is the STRAIGHTFORWARD side of it: `false`,
 * because readiness §3.1.4 M5's machine carve-out does not apply.
 *
 * The caller supplies an `id`, so the field looks like it should be `true` — but
 * D20's subject is a caller-supplied id that could be ITERATED to learn whether a
 * row exists across an ownership boundary. `callerSuppliedTargetId: true` obliges
 * the invisible-fails-as-nonexistent answer, and that is exactly what the shipped
 * service does; what it does NOT have is M5's distinguishability requirement,
 * because no machine is nameable here and there is no unauthorized-versus-
 * unreachable pair to keep apart. Declaring `true` with
 * `distinguishesUnauthorizedFromUnreachable: false` would be the honest shape and
 * is what this is: see the value below.
 */
const APPROVAL_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'The `id` is caller-supplied and could otherwise be iterated to learn which approvals exist, so ' +
    'D20.2 governs: a row this principal may not see fails identically to one that does not exist. ' +
    'readiness §3.1.4 M5’s carve-out does NOT apply — it protects the ability to tell "you may not ' +
    'use this machine" from "this machine is offline", and no machine is nameable on this surface. ' +
    'There is nothing here to keep distinguishable, so the flag is false rather than copied from a ' +
    'machine-placing neighbour.',
}

/** Neither command mints an entity. Stated, so "creates nothing" and "I forgot the
 *  field" cannot look alike — the row already exists, raised by the requester. */
const CREATES_NOTHING = {
  creates: [],
  note:
    'Decides a request that already exists; mints no entity and moves no ownership. The row’s owner ' +
    'stays the routed-to human it was addressed to, and a decision does not re-home it.',
} as const

/** The server-minted approval id. One shape, declared once, so the two cannot
 *  drift into two slightly different notions of "which request". */
const byId = z.object({ id: z.string().min(1) })

// ---------------------------------------------------------------------------
// approvals.approve
// ---------------------------------------------------------------------------

export const approvalsApproveInput = byId

export const approvalsApproveContract = {
  name: 'approvals.approve',
  version: 1,
  visibility: APPROVAL_VISIBILITY,
  input: approvalsApproveInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'MANAGE, not write: approving does not edit a row, it RELEASES a held operation — the service ' +
      'executes the pending op through the closed server catalog or hands it to the daemon, and the ' +
      'state transition is the receipt. ADR 3 D2 grades by what a command lets happen, so a command ' +
      'that authorizes an operation the requester could not perform alone cannot share a grade with ' +
      '"may edit a row". `roleFloor: member` is not in tension with that (Amendment 1 D15: the floor ' +
      'is which commands you may ATTEMPT, the action is which rows you may TOUCH) — the routed-to ' +
      'human is routinely an ordinary member, and an admin floor would lock them out of their own ' +
      'queue. `resource: none` because the gate is the row’s own routed-to owner rather than a ' +
      'containing entity; the approval IS the target. NO CONFIRMATION, deliberately: this command ' +
      'IS the confirmation step — ADR 3 D2 puts destructive writes behind a broker, and the broker ' +
      'asking for its own confirmation would be an infinite regress with a dialog in it.',
  },
  exposure: SERVED_ON,
  delivery: APPROVAL_DELIVERY,
  redaction: APPROVAL_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: APPROVAL_ATTRIBUTION,
  errorConsistency: APPROVAL_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'ROW.approvals declared rule: the FIRST decision settles the request, and a second decision on a settled request is refused rather than overwriting it',
} as const satisfies CommandContract<typeof approvalsApproveInput>

// ---------------------------------------------------------------------------
// approvals.deny
// ---------------------------------------------------------------------------

export const approvalsDenyInput = byId

/**
 * Terminal, and it carries the SAME grade as `approve` rather than a lower one.
 *
 * The tempting asymmetry — approving is powerful, denying is safe — is wrong, and
 * it is the kind of wrong that only shows up under multi-user. A denial is a
 * final answer that cannot be revisited (`tombstone: 'never-delete'`, terminal
 * states retained), so a principal who may deny can permanently refuse work on
 * behalf of the human the request was routed to. That is the same authority
 * pointed the other way, not a smaller one.
 */
export const approvalsDenyContract = {
  name: 'approvals.deny',
  version: 1,
  visibility: APPROVAL_VISIBILITY,
  input: approvalsDenyInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'The same grade as `approve`, deliberately, and the symmetry is the decision. Denial reads as ' +
      'the safe direction, but it is TERMINAL — the matrix retains terminal states forever — so a ' +
      'principal who may deny can permanently refuse work on behalf of the human the request was ' +
      'routed to. That is the same authority pointed the other way, and grading it lower would let ' +
      'a narrower principal veto decisions it may not make. Everything else is `approve`’s and for ' +
      'its reasons: `resource: none` because the approval IS the target, `roleFloor: member` because ' +
      'the routed-to human is routinely one, and no confirmation because this surface IS the ' +
      'confirmation step.',
  },
  exposure: SERVED_ON,
  delivery: APPROVAL_DELIVERY,
  redaction: APPROVAL_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: APPROVAL_ATTRIBUTION,
  errorConsistency: APPROVAL_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'As approvals.approve — first decision settles, and approve racing deny resolves to whichever the Authority commits first',
} as const satisfies CommandContract<typeof approvalsDenyInput>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The two WRITES, keyed by the proc name the wire already uses.
 *
 * `list` — the pending queue — is deliberately NOT here, the same split every
 * family in this phase made: a `visibility` class describes what a command WRITES
 * and a read writes nothing, so declaring one would put a graded value in the
 * audit surface for a row the query does not touch. It stays a query, and the
 * family audit checks procedure TYPE, so a write cannot rejoin it by being spelled
 * as one.
 */
export const APPROVAL_CONTRACTS = {
  approve: approvalsApproveContract,
  deny: approvalsDenyContract,
} as const

export type ApprovalContractName = keyof typeof APPROVAL_CONTRACTS

/** Sorted so a table-driven consumer's order does not depend on declaration order. */
export const APPROVAL_CONTRACT_NAMES = Object.keys(
  APPROVAL_CONTRACTS,
).sort() as ApprovalContractName[]
