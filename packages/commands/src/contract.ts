/**
 * THE command contract shape — ADR 3 D1's field table, plus the columns ADR 3
 * Amendment 1 (POD-1073) and ADR 1 Amendment 1 (POD-1071) added when Podium
 * became multi-user within one tenant.
 *
 * PORT REFERENCE: `docs/command-and-reducer-ports.md` documents these shapes for
 * POD-372 (optimistic overlay) and POD-311 (Phase 3, which populates contracts and
 * reducers broadly). `sessions/rename.ts` is the worked example POD-351 established.
 *
 * L1 RULE: this file is pure data and pure functions. It may reference
 * `@podium/model` and `@podium/protocol` (schemas, brands, the principal
 * taxonomy) and nothing else. A handler lives with its L3 feature and is joined
 * to its contract at the composition root — co-locating them here would make an
 * L1 package depend on L3 services, which is finding 1 of POD-311's revision.
 *
 * TOTALITY IS THE POINT. Every field below is REQUIRED, including the ones whose
 * answer is "none". Optionality is how a column silently stops being filled in:
 * a missing `exposure` must mean "served nowhere" (ADR 3 D3 rule 1) and a missing
 * visibility class must mean "personal and private" (ADR 9 D4), and neither of
 * those defaults is reachable if the field can simply be absent. The two
 * deliberate exceptions are `optimisticReducer` (ADR 3 D6: "absence is valid")
 * and `machineVerb` (only a contract that places work on owned compute has one) —
 * and both are checked by {@link classificationErrors} rather than trusted.
 */

import type { z } from 'zod'

// ---------------------------------------------------------------------------
// D2 — resource / action policy
// ---------------------------------------------------------------------------

/** ADR 3 D2's action vocabulary — the same three literals as the model's
 *  `IssueAction` (viewer=read · worker=+write · admin=+manage). */
export type CommandAction = 'read' | 'write' | 'manage'

/** ADR 3 D2's resource scope kinds, extended by Amendment 1 D19 with the owner
 *  and grant scopes personal entities need. `none` is the additive /
 *  self-addressed case (`mailSend`'s deliberate non-entry) and must be WRITTEN,
 *  never reached by omitting the field. */
export type CommandResource =
  | 'issue'
  | 'repo'
  | 'session'
  | 'machine'
  | 'settings-domain'
  | 'secret'
  | 'global'
  | 'none'

/** ADR 3 D2's confirmation rule for destructive or out-of-scope writes. */
export type ConfirmationRule = 'none' | 'confirm' | 'broker'

/** ADR 9 D6 / ADR 3 Amendment 1 D18's owned-compute verbs. `use` is a
 *  CODE-EXECUTION boundary (readiness §3.1.4 M2), never a privacy one. */
export type MachineVerb = 'see' | 'use' | 'manage'

/** ADR 3 Amendment 1 D15 / readiness §3.2's account grades. A role is a floor on
 *  which commands you may ATTEMPT; it never decides which ROWS you may touch. */
export type RoleFloor = 'member' | 'admin'

export interface CommandPolicy {
  /** Role floor: which commands the principal may ATTEMPT (Amendment 1 D15). */
  readonly action: CommandAction
  /** The account grade floor. `admin` means a member may not attempt it at all. */
  readonly roleFloor: RoleFloor
  /** Which rows the principal may TOUCH (Amendment 1 D15) — the target class. */
  readonly resource: CommandResource
  /** D2's escape for deliberate widening (`--outside-scope` / `overrideScope`). */
  readonly confirmation: ConfirmationRule
  /**
   * Present iff the command places work on owned compute. Checked against the
   * EFFECTIVE principal (readiness §3.1.4 M6: agents inherit machine grants
   * through the A1/A2 intersection, so this is one check, not a fleet ACL).
   */
  readonly machineVerb?: MachineVerb
  /** Why this policy and not a neighbouring one. Required: a policy nobody can
   *  audit is a policy that drifts. */
  readonly rationale: string
}

// ---------------------------------------------------------------------------
// D3 — transport exposure, default-closed
// ---------------------------------------------------------------------------

export type TransportTag = 'trpc' | 'cli' | 'mcp' | 'relay' | 'outbox' | 'peer'

/** The empty set, named. A contract exposing nothing says so with this constant
 *  rather than with `[]`, so "I forgot" and "I decided" do not look alike. */
export const SERVED_NOWHERE: readonly TransportTag[] = []

// ---------------------------------------------------------------------------
// D4 — delivery / offline class
// ---------------------------------------------------------------------------

export type DeliveryClass = 'offline-eligible' | 'online-only' | 'online-sensitive'

/**
 * The offline class WITH its reasoning, because for this vertical the default
 * would have been wrong. Agent mail is durable-queued by design — the server
 * holds `queued_messages` for an unreachable agent — and ADR 3 D4 rule 4 says
 * in as many words that a server-held agent queue is "a delivery mechanism for
 * already-authorized online commands, NOT a client Outbox offline class". The
 * two durabilities are different objects and reconciling them is this issue's
 * assignment, so the rationale is a required field and not a comment.
 */
export interface DeliveryPolicy {
  readonly class: DeliveryClass
  /** How this class reconciles with the kernel Outbox (ADR 3 D4 rule 4 / D9). */
  readonly outboxReconciliation: string
  /**
   * ADR 3 D8 / Amendment 1 D16: what happens when the principal's rights change
   * between enqueue and drain. Required for every class — "we re-authorize" is
   * only half an answer; the other half is what the sender is told.
   */
  readonly applyTimeReauthorization: string
}

// ---------------------------------------------------------------------------
// D5 — redaction
// ---------------------------------------------------------------------------

/**
 * Sensitive input/output paths (ADR 3 D5). `paths` is dotted and may be empty —
 * but `reviewed` must be `true` either way, which is what distinguishes "this
 * command carries nothing sensitive" from "nobody looked".
 */
export interface RedactionPolicy {
  readonly reviewed: true
  readonly inputPaths: readonly string[]
  readonly outputPaths: readonly string[]
  readonly note: string
}

// ---------------------------------------------------------------------------
// Amendment 1 D19 / ADR 9 D3-D4 — ownership and visibility
// ---------------------------------------------------------------------------

/** ADR 9 D3's five visibility classes, restated as the L1 contract's vocabulary.
 *  Kept in lockstep with `VISIBILITY_CLASSES` in `@podium/model`. */
export type VisibilityClass =
  | 'personal'
  | 'per-user-state'
  | 'owned-compute'
  | 'deployment-substrate'
  | 'secret'

/**
 * Who owns what the command CREATES, and what the child inherits — ADR 9 D5 A4
 * and readiness §3.1.2's per-class inheritance declaration. A command that
 * creates nothing says so; it does not leave the field off.
 */
export type CreationOwnership =
  | {
      readonly creates: readonly string[]
      /** ADR 9 D5 A4: owner = the on-behalf-of human, actor = the agent. */
      readonly owner: 'on-behalf-of-human'
      readonly visibility: VisibilityClass
      /** ADR 9 §3 O4: state the inheritance rule, do not leave it to handler code. */
      readonly inheritanceOnCreate: 'parent' | 'on-behalf-of-human'
      readonly note: string
    }
  | { readonly creates: readonly []; readonly note: string }

// ---------------------------------------------------------------------------
// Amendment 1 D17 — attribution is a pair
// ---------------------------------------------------------------------------

/**
 * ADR 3 D7 + Amendment 1 D17: both halves stamped from the transport principal,
 * never from payload. `wirePlacement` records the decision this issue was asked
 * to make explicitly — a wire shape is cheap before the POD-308 cutover and
 * expensive after it.
 */
export interface AttributionPolicy {
  readonly actor: 'from-capability' | 'not-applicable'
  readonly onBehalfOf: 'from-delegation' | 'none-representable'
  /**
   * `separate-field` — attribution rides its own wire keys, distinct from any
   * routing address. `folded-into-address` would mean an address field doubles
   * as the accountability record.
   */
  readonly wirePlacement: 'separate-field' | 'folded-into-address' | 'not-on-the-wire'
  /** The wire keys reserved for the pair, so POD-308 freezes the right shape. */
  readonly reservedWireKeys: readonly string[]
  readonly rationale: string
}

// ---------------------------------------------------------------------------
// Amendment 1 D20 — the consistent-error rule
// ---------------------------------------------------------------------------

/**
 * Whether this command takes a CALLER-SUPPLIED target id, and therefore whether
 * it could become an existence oracle (Amendment 1 D20.3: the rule is general,
 * not mail-specific). Expressed here, in the contract, rather than as an ad-hoc
 * string in one handler — so the next command author inherits it (readiness
 * §3.1.5, and the same default-closed instinct as ADR 3 D3).
 */
export type ErrorConsistency =
  | {
      readonly callerSuppliedTargetId: true
      /**
       * Invisible-vs-nonexistent must be indistinguishable. The one carve-out
       * the pack grants is machine placement (readiness §3.1.4 M5), where
       * unauthorized MUST stay distinguishable from unreachable — the two rules
       * pull in opposite directions and D20.2 vs M5 decide them separately.
       */
      readonly invisibleFailsAs: 'nonexistent'
      readonly distinguishesUnauthorizedFromUnreachable: boolean
      readonly note: string
    }
  | { readonly callerSuppliedTargetId: false; readonly note: string }

// ---------------------------------------------------------------------------
// D6 — optional optimistic reducer
// ---------------------------------------------------------------------------

/**
 * The actor half of the authored attribution pair, BY KIND ONLY (POD-351).
 *
 * A reducer receives this and never an identity. `session.rename`'s arbitration
 * ([spec:SP-eb60]) turns on human-versus-agent, so a reducer that could not see
 * the kind could never predict a refusal — and the rejection member below would
 * be a shape with no possible caller. It learns "an agent wrote this"; it has no
 * argument with which to ask "may this agent write this".
 *
 * Structurally compatible with `@podium/sync`'s `PendingAttribution` by
 * construction and by assertion, NOT by coincidence — see the note on
 * {@link OptimisticEffect}.
 */
export interface AuthoredAttribution {
  /** The human the write is on behalf of (ADR 9 D5 A4's provisional owner). */
  readonly onBehalfOf: string
  /** Opaque to the Replica; a reducer reads only `kind`. */
  readonly actor: unknown
}

/**
 * WHAT A REDUCER SAYS A PENDING COMMAND WOULD DO — the contract layer's copy of
 * the kernel's `OptimisticEffect`.
 *
 * ## Why this is declared twice, and why that is not the redefinition the ADRs forbid
 *
 * `packages/sync/src/replica/` is DIRECTION-LOCKED: it imports nothing outside
 * itself but the span port (`check-boundaries` rule 10, ADR 1 D1 / ADR 2
 * Amendment 1 D12.7), because a Replica that could reach the contract vocabulary
 * would be a Replica that could interpret commands — which is arbitration. So the
 * kernel declares the port it CONSUMES, and this package declares the vocabulary
 * it PROVIDES. That is a port declared by the consumer and implemented by the
 * provider, joined by an adapter at the composition root; it is the same
 * hexagonal shape the rest of the pack uses, not a second home for one fact.
 *
 * ## What stops them drifting, since two declarations can
 *
 * Structural compatibility is asserted BIDIRECTIONALLY at the composition root
 * where both types are importable, with a non-vacuity probe beside it — an
 * assignment that compiles proves nothing if it would compile against anything.
 * A member added on one side and not the other fails that assertion at build
 * time. The alternative — putting this in `@podium/model` — would move a
 * command-plane concept into the L0 leaf that ADR 4 reserves for entity
 * vocabulary, to avoid a duplication that is already caught.
 */
export type OptimisticEffect =
  /** The provisional value after this command. Materialises a row if there is none. */
  | { readonly kind: 'value'; readonly value: unknown }
  /** Optimistically absent — the command removes the row from the view. */
  | { readonly kind: 'absent' }
  /** No client-derivable effect. Render pending; never guess (ADR 3 D6). */
  | { readonly kind: 'no-reducer' }
  /**
   * The reducer PREDICTS the authority will refuse, and can say why (POD-351).
   * Advisory only: the command stays queued and is still judged live at apply.
   * Derivable from the authoritative row + the command; never from a principal.
   */
  | { readonly kind: 'rejected'; readonly reason: string }

/**
 * ADR 3 D6's optional optimistic reducer. Pure, total, and handed no principal.
 *
 * `local` is the authoritative row from the principal's slice, or `undefined`
 * when the slice holds none — the only case in which a reducer may materialise
 * one. `authored` is the pair the write was recorded under, forwarded from the
 * Outbox verbatim.
 */
export type OptimisticReducer<In> = (args: {
  input: In
  local: unknown
  now: string
  authored?: AuthoredAttribution
}) => OptimisticEffect

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Everything about a contract that does NOT mention its schema type. Split out
 * because `In` appears in `optimisticReducer`'s argument, which makes TypeScript
 * treat the parameter as invariant: without this split a
 * `CommandContract<ZodObject<…>>` is not assignable to
 * `CommandContract<ZodTypeAny>`, and a heterogeneous registry table cannot be
 * typed at all. `AnyCommandContract` below is the erased form the registry and
 * the classification lint take.
 */
export interface CommandContractBase {
  /** Stable dotted wire name (`mail.send`). */
  readonly name: string
  /**
   * THE VISIBILITY CLASS OF WHAT THIS COMMAND WRITES (POD-382; ADR 9 D3/D4,
   * readiness §3.1.1 rules 1 and 2).
   *
   * `policy` says whose authority a write answers to and which rows it may touch.
   * This says which of ADR 9's five classes the state belongs to — the question a
   * scoped feed and a share dialog both ask, and the one nothing on this contract
   * could answer before.
   *
   * REQUIRED, like every other field here, and for the reason the file header
   * gives: a missing visibility class must mean "personal and private" (ADR 9 D4),
   * and that default is not reachable if the field can simply be absent. The
   * semantic backstop still exists for anything constructed outside this type
   * (`visibilityClassOf` in `@podium/model`, `commandVisibility` in
   * `@podium/protocol`); this is the compile-time half, and neither substitutes
   * for the other.
   */
  readonly visibility: VisibilityClass
  /** Positive integer, starts at 1; bumped on an incompatible schema change. */
  readonly version: number
  readonly policy: CommandPolicy
  /** ADR 3 D3: EMPTY MEANS SERVED NOWHERE. There is no "expose everywhere". */
  readonly exposure: readonly TransportTag[]
  readonly delivery: DeliveryPolicy
  readonly redaction: RedactionPolicy
  readonly ownership: CreationOwnership
  readonly attribution: AttributionPolicy
  readonly errorConsistency: ErrorConsistency
  /** Presentation hints only — never security fields. */
  readonly cli?: { readonly positional?: readonly string[]; readonly summary?: string }
}

export interface CommandContract<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown>
  extends CommandContractBase {
  readonly input: In
  /** ADR 3 D6: absence is valid and means "show pending, guess nothing". */
  readonly optimisticReducer?: OptimisticReducer<z.infer<In>>
  /** Phantom output marker so `Out` survives inference; never set at runtime. */
  readonly __out?: Out
}

/** A contract with its schema type erased — what a heterogeneous table holds. */
export interface AnyCommandContract extends CommandContractBase {
  readonly input: z.ZodTypeAny
}

export type ContractInput<C extends { readonly input: z.ZodTypeAny }> = z.infer<C['input']>

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

/**
 * The classification lint, as a function so both a unit test and a future
 * registry-wide gate run the SAME check (ADR 3 D3 rule 1's "compile- and
 * test-enforced totality").
 *
 * It answers the acceptance criterion "classifications are total, with no
 * unclassified field defaulting to exposed". Note what that requires beyond
 * "the field is present": a contract may not be exposed on `outbox` unless its
 * delivery class is offline-eligible (D3 rule 2), a `secret` resource forces
 * `online-sensitive` (D4 rule 1), and a command taking a caller-supplied target
 * id must have answered D20.
 */
/**
 * Dotted names allowed to be `offline-eligible` DESPITE placing work on owned
 * compute (D18.3). Empty in this package today, and the emptiness is the claim:
 * the one known exception fleet-wide is `sessions.resumeAndSend`, whose
 * offline-eligibility the client outbox oracle pins as must-not-change, and it
 * lives in the protocol-side table until POD-311 folds that table in here — at
 * which point it belongs in this list rather than in a second rule.
 *
 * An entry here is a licence, so it is checked: `contract.test.ts` asserts every
 * name in this list belongs to a contract that actually exists. A licence for an
 * undeclared command would silently pre-authorize whoever next used that name.
 */
export const MACHINE_USE_OFFLINE_EXCEPTIONS: readonly string[] = []

export function classificationErrors(contract: AnyCommandContract): string[] {
  const errs: string[] = []
  const at = (msg: string): void => {
    errs.push(`${contract.name}: ${msg}`)
  }
  if (!Number.isInteger(contract.version) || contract.version < 1)
    at('version must be a positive integer')
  if (!contract.name.includes('.')) at('name must be a dotted wire name')
  if (contract.policy.rationale.trim() === '') at('policy.rationale is required')
  if (contract.delivery.outboxReconciliation.trim() === '') {
    at('delivery.outboxReconciliation is required — the offline class must be DELIBERATE')
  }
  if (contract.delivery.applyTimeReauthorization.trim() === '') {
    at('delivery.applyTimeReauthorization is required (ADR 3 D8)')
  }
  if (contract.redaction.reviewed !== true) at('redaction must be explicitly reviewed')
  if (contract.redaction.note.trim() === '') at('redaction.note is required')
  // D3 rule 2.
  if (contract.exposure.includes('outbox') && contract.delivery.class !== 'offline-eligible') {
    at('exposed on `outbox` without an offline-eligible delivery class (ADR 3 D3 rule 2)')
  }
  // D4 rule 1 and rule 3.
  if (contract.policy.resource === 'secret' && contract.delivery.class !== 'online-sensitive') {
    at('a `secret` resource forces `online-sensitive` (ADR 3 D4 rule 1)')
  }
  // D18/M5: a contract that places work on owned compute must declare the verb
  // AND must keep unauthorized distinguishable from unreachable.
  if (contract.policy.resource === 'machine' && contract.policy.machineVerb === undefined) {
    at('a `machine` resource must declare its verb (ADR 3 Amendment 1 D18)')
  }
  // NO CONVERSE RULE, and its absence is a correction POD-640 had to make.
  //
  // This lint used to read `machineVerb declared on a non-machine resource` — an
  // error. That contradicted the vocabulary's own design note: `framework.ts`'s
  // `CommandPolicy.machineVerb` says in as many words that the verb is "a SECOND
  // axis rather than `resource: 'machine'` because collapsing them would lose the
  // row gate", and the shipped session command plane relies on exactly that shape
  // (`sessions.sendText` and `sessions.kill` are `resource: 'session'` AND
  // `machineVerb: 'use'`, because typing into a PTY runs code on someone's
  // hardware while the row gate stays the session's owner). D15.2: neither check
  // substitutes for the other.
  //
  // So the two directions are NOT symmetric, and only one of them holds:
  //  - a `machine` RESOURCE must declare a verb (checked above) — there is
  //    nothing else for its grants to hang on;
  //  - a verb does NOT imply a `machine` resource, because the resource names the
  //    ROW gate and the verb names the EXECUTION gate.
  //
  // Keeping the old rule would have forced any command that both writes a row and
  // executes on compute to lie about one of them. `mail.ask` and `mail.send` are
  // that shape: they deliver at `lifecycle: 'wake'`, which spawns, while their row
  // gate is the session/issue address.
  if (
    contract.policy.machineVerb === 'use' &&
    // M5 IS KEYED ON THE MACHINE BEING NAMEABLE, not on any caller-supplied id.
    //
    // The hazard readiness §3.1.4 M5 names is a caller PROBING which of a
    // colleague's machines are online by reading the difference between "denied"
    // and "offline" — which requires the caller to be able to name a machine.
    // `mail.spawnAgent` can (placement takes an execution profile), so it must
    // distinguish. `mail.send` and `mail.ask` cannot: their address is an issue or
    // a session ref, the machine is wherever the target session already lives, and
    // there is no machine argument to iterate. Keying this on
    // `callerSuppliedTargetId` instead put those two in an impossible position —
    // M5 demanding they distinguish, D20.2 demanding they must not — for a probe
    // that cannot be mounted through them.
    contract.policy.resource === 'machine' &&
    contract.errorConsistency.callerSuppliedTargetId &&
    !contract.errorConsistency.distinguishesUnauthorizedFromUnreachable
  ) {
    at(
      'machine `use` must keep unauthorized distinguishable from unreachable (readiness §3.1.4 M5)',
    )
  }
  // D18.3 — a command that EXECUTES on owned compute may not be queued and
  // replayed after the world has moved. Added by POD-642, whose `sessions.handoff`
  // is the first `use` tenant of this package.
  //
  // A LINT AND NOT A DERIVATION, deliberately, per the rule the coordinator
  // adopted fleet-wide while POD-380 and POD-381 settled it: `delivery.class` stays
  // EXPLICIT with its reasoning in `outboxReconciliation`, and D18.3 is enforced as
  // a check over that declaration. Deriving the class from the verb would make the
  // implication silent and unauditable — and it would erase the one legitimate
  // exception the protocol-side table carries (`sessions.resumeAndSend`, which the
  // client outbox oracle pins as offline-eligible must-not-change). MAKE THE
  // EXCEPTION VISIBLE, DO NOT MAKE THE RULE SILENT: an exception belongs in the
  // list below, named, where a reader can find it.
  if (
    contract.policy.machineVerb === 'use' &&
    contract.delivery.class === 'offline-eligible' &&
    !MACHINE_USE_OFFLINE_EXCEPTIONS.includes(contract.name)
  ) {
    at(
      'machine `use` executes on someone else’s hardware and may not be offline-eligible (ADR 3 Amendment 1 D18.3) — name it in MACHINE_USE_OFFLINE_EXCEPTIONS if it genuinely is one',
    )
  }
  // D17: an actor that is not stamped from the capability is an actor a payload
  // could set. There is deliberately no `from-payload` member; this catches the
  // other half — a pair that claims a human but has no delegation to resolve it.
  if (
    contract.attribution.onBehalfOf === 'from-delegation' &&
    contract.attribution.actor === 'not-applicable'
  ) {
    at('an on-behalf-of human with no actor is not an attribution PAIR (Amendment 1 D17)')
  }
  if (
    contract.attribution.wirePlacement === 'separate-field' &&
    contract.attribution.reservedWireKeys.length === 0
  ) {
    at('wirePlacement `separate-field` must name the reserved wire keys')
  }
  if (contract.attribution.wirePlacement === 'folded-into-address') {
    at('attribution may not be folded into a routing address (Amendment 1 D17: it is a PAIR)')
  }
  // ADR 9 D5 A4 — anything a command creates is owned by the on-behalf-of human.
  if (contract.ownership.creates.length > 0 && !('owner' in contract.ownership)) {
    at('a command that creates entities must declare their owner (ADR 9 D5 A4)')
  }
  if (contract.ownership.note.trim() === '') at('ownership.note is required')
  // ADR 9 D3/D6, ONE DIRECTION ONLY, and the asymmetry is the whole point.
  //
  // `visibility` classifies THE STATE THE COMMAND WRITES; `policy.resource` names
  // what it authorizes AGAINST. For most of this fleet those differ on purpose: a
  // spawn, a handoff and an agent-spawn all authorize against a MACHINE (`use`, a
  // code-execution boundary — readiness §3.1.4 M2) while what they write is a
  // SESSION, which is personal. So a `machine` resource does NOT imply
  // `owned-compute` state, and the first draft of this lint asserted that it did —
  // it fired on `mail.spawnAgent` and on `sessions.rename` inside another test's
  // fixture, both of which were correctly classified. The machine side is already
  // covered: `machineVerb` is required for a `machine` resource, checked above.
  //
  // What DOES hold is the converse: a command that writes owned-compute state — a
  // machine row, a pairing, a fleet membership — must be authorized against the
  // machine, because there is nothing else for its grants to hang on.
  if (contract.visibility === 'owned-compute' && contract.policy.resource !== 'machine') {
    at('visibility `owned-compute` must name the `machine` resource (ADR 9 D6)')
  }
  if (contract.visibility === 'secret' && contract.delivery.class !== 'online-sensitive') {
    at('a `secret` visibility class forces `online-sensitive` (ADR 3 D4 rule 1)')
  }
  if (contract.errorConsistency.note.trim() === '') at('errorConsistency.note is required')
  return errs
}

/** Every classification error across a table of contracts. */
export function registryClassificationErrors(contracts: readonly AnyCommandContract[]): string[] {
  const errs = contracts.flatMap(classificationErrors)
  const names = contracts.map((c) => c.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  for (const d of new Set(dupes)) errs.push(`${d}: duplicate contract name`)
  return errs
}
