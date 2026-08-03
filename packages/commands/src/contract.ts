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
 *
 * `conflict` JOINED THAT RULE IN POD-1250, and it is the sharpest case of it: ADR
 * 1 has no safe default merge policy to fall back to, so an absent class could not
 * even be given the fail-closed reading `visibility` gets. The answer for a
 * command with no replicated row is the WRITTEN `'n/a'` — see
 * {@link ContractConflictClass}. `conflictRule` remains conditional, because it is
 * required by exactly one class and forbidden by the rest; the union in
 * {@link ConflictDeclaration} and a check in {@link classificationErrors} hold it.
 */

import type { z } from 'zod'
import type { ConflictClass, ContractConflictClass } from './framework'

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
 * THE CONFLICT VOCABULARY AS A CONTRACT ANSWERS IT — ADR 1's six arbitration
 * classes, plus `'n/a'` for a command with no replicated row to arbitrate.
 *
 * WHY THE EXTRA MEMBER EXISTS, AND WHY IT IS NOT A LOOPHOLE. Making {@link
 * CommandContractBase.conflict} required (POD-1250) asks the question of EVERY
 * contract, and a large minority of this fleet are queries: `issues.list`,
 * `mail.ledger`, `settings.secretPresence`. A query has no ADR 1 row, so each of
 * the six classes would be a FABRICATION — and this file already refuses that
 * trade in as many words at {@link MutatingCommandContractBase}, where it
 * declines to key the requirement on `policy.action` because "deriving the
 * requirement from `action` would force a conflict class onto a command that has
 * no ADR 1 row, which is a fabricated arbitration rule". Requiring the field
 * without offering an honest non-answer would fabricate at fifty sites instead of
 * one.
 *
 * SPELLED `'n/a'` BECAUSE THE MATRIX ALREADY SPELLS IT THAT WAY. This is not a
 * new concept invented for the command plane: `@podium/model`'s `ConflictRule`
 * (`annotations/ownership.ts`) carries `'n/a'` for exactly this — the rows, like
 * `instanceId` and `pairingToken`, that have no merge policy because nothing
 * concurrent writes them. A contract and its matrix row are routinely read
 * side by side, and giving the same fact two spellings is how a reader starts
 * believing they are two facts. `ConflictClass` — this package's six-member
 * subset — is what remains once the two rules with no COMMAND behind them
 * (`'n/a'`, `'live-ephemeral'`) are dropped; this type puts the first one back
 * for the contract that needs to say it out loud.
 *
 * IT MUST BE WRITTEN, never reached by omitting the field, and that is the whole
 * value of the change: an absent field cannot distinguish a command that HAS no
 * row from a command whose row nobody classified, because both spell themselves
 * as a missing property. {@link CommandResource}'s own `'none'` member carries
 * the identical note for the identical reason.
 *
 * `'n/a'` NEVER REACHES THE ENGINE. {@link ConflictClass} — the vocabulary
 * `packages/sync/src/authority/arbitration.ts` resolves against — is deliberately
 * NOT widened here, so no arbitration lookup can receive `'n/a'` and have to grow
 * a branch that fails open. A mutation cannot smuggle one in either: {@link
 * MutatingCommandContractBase} and {@link ConflictDeclaration} both narrow the
 * field back to {@link ConflictClass}, so the moment a contract is declared as a
 * mutation, `'n/a'` stops typechecking.
 *
 * The remaining hazard is a genuine mutation declared as a plain {@link
 * CommandContract} with `'n/a'` — a family forgetting to name a mutating member.
 * The type cannot catch that (it is the same gap the `satisfies
 * MutatingCommandContract` seam has always had), so {@link classificationErrors}
 * carries the semantic half: an `'n/a'` contract that CREATES entities, or that
 * is queued on the client Outbox, is an error. Neither substitutes for the other
 * (D15.2).
 */
export type { ContractConflictClass }

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
  /**
   * ADR 1's conflict class for what this command writes — the arbitration rule,
   * declared on the contract so it travels with the command rather than living
   * only in a doc table. Vocabulary is {@link ContractConflictClass}: ADR 1's six
   * classes, plus the WRITTEN `'n/a'` a non-mutating command answers with.
   *
   * REQUIRED, like every other field here, and for the reason the file header
   * gives (POD-1250). It was optional for exactly one release while POD-1246's
   * catch-up merge was in flight, on the grounds that a required field on the
   * shared base cascades to every namespace at once and deserved its own review
   * rather than riding along inside 109 conflicts. This is that review.
   *
   * There is no safe default, which is why the answer cannot be an ABSENCE.
   * `arbitration.ts` is explicit that picking one silently "is how a class ends up
   * with whole-aggregate LWW that nobody chose", so there is nothing for an
   * omission to resolve TO — unlike `visibility`, which at least has `personal`
   * to fail closed toward. `'n/a'` is a positive claim that this command writes
   * no replicated row, not a way of declining to answer; see
   * {@link ContractConflictClass}.
   */
  readonly conflict: ContractConflictClass
  /**
   * The command's own documented rule, REQUIRED when {@link conflict} is `'cmd'`.
   *
   * Not decoration: `packages/sync/src/authority/arbitration.ts` requires a rule
   * for `cmd` rows and THROWS rather than waving one through — "otherwise it is a
   * synonym for unchecked". A `'cmd'` row with no rule is a row the engine
   * refuses to arbitrate, so the two fields are declared and checked together.
   */
  readonly conflictRule?: string
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

/**
 * THE CONFLICT DECLARATION AS A CLOSED PAIR — the compile-time half of ADR 1's
 * arbitration, ported from main's registry at the POD-1246 catch-up.
 *
 * Main carried this as a conditional on the registry DEF
 * (`K extends 'mutation' ? { concurrency: CommandConcurrency } : { concurrency?: never }`,
 * `apps/server/src/modules/issues/registry.ts`). It is re-declared HERE, on the
 * contract, because integration's `def()` merges `input` and `action` FROM the L1
 * contract — so the contract is where a declaration travels with the command, and
 * a tripwire on `CommandDef` would guard a type the issue family no longer uses.
 *
 * WHY A UNION AND NOT TWO OPTIONAL FIELDS. `packages/sync/src/authority/arbitration.ts`
 * REQUIRES a rule for `cmd` rows and THROWS rather than waving one through —
 * "otherwise it is a synonym for unchecked". A `cmd` row with no rule is a row the
 * engine refuses to arbitrate, so the two fields are one decision and the type says
 * so: `cmd` demands the string, every other class forbids it. Spelling that as two
 * independent optionals would let the compiler accept exactly the fifteen rows
 * POD-1247's engine would later reject at runtime.
 *
 * The `never` arm is deliberate: a rule attached to an `exp-rev` row is a rule
 * nothing reads, which is how a doc-shaped field starts disagreeing with the
 * behaviour it claims to describe.
 */
export type ConflictDeclaration =
  | {
      readonly conflict: Exclude<ConflictClass, 'cmd'>
      readonly conflictRule?: never
    }
  | {
      readonly conflict: 'cmd'
      /** What the command's own rule IS — see {@link ConflictDeclaration}. */
      readonly conflictRule: string
    }

/**
 * A contract for a command that MUTATES REPLICATED STATE: everything
 * {@link CommandContract} requires, plus a conflict class that is not optional.
 *
 * This is the type that makes the 43 issue declarations MECHANICAL rather than 43
 * separate judgements — omit one and the compiler names the site.
 *
 * STILL LOAD-BEARING NOW THAT THE BASE REQUIRES THE FIELD (POD-1250), because the
 * two types ask different questions. The base asks "what is the answer?" and
 * accepts `'n/a'`; this asks "and it may not be `'n/a'`", since a command that
 * mutates replicated state HAS a row by definition. Narrowing
 * {@link ContractConflictClass} back to {@link ConflictClass} is the whole content
 * of this interface, and it is what keeps `'n/a'` from becoming the shrug the
 * absent field used to be.
 *
 * NOT KEYED ON `policy.action`, and the exception is the reason. `action` is an
 * AUTHORITY fact, not a mutation fact, and main says so in the one contract where
 * they disagree: `issues.linearSearch` is `kind: 'query'` with `action: 'write'`
 * because it spends a third-party credential — write-grade authority, no Podium row
 * to arbitrate. Deriving the requirement from `action` would force a conflict class
 * onto a command that has no ADR 1 row, which is a fabricated arbitration rule.
 * Each family therefore names its mutating members; see `issues/contracts.ts`.
 */
export interface MutatingCommandContractBase extends CommandContractBase {
  readonly conflict: ConflictClass
}
export type MutatingCommandContract<
  In extends z.ZodTypeAny = z.ZodTypeAny,
  Out = unknown,
> = CommandContract<In, Out> & ConflictDeclaration

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

/**
 * {@link ContractConflictClass}'s members as a VALUE, so the runtime check in
 * {@link classificationErrors} enumerates the same seven the type does.
 *
 * Kept in sync by construction rather than by discipline, in BOTH directions —
 * `satisfies` catches a member that is not a class, and the exhaustiveness
 * tripwire below catches a class that is not a member. Only the second one
 * matters for safety: a class added to the type and forgotten here would pass the
 * runtime lint silently while the type accepted it, which is exactly the
 * "declared but unchecked" failure this file exists to prevent.
 */
export const CONTRACT_CONFLICT_CLASSES = [
  'exp-rev',
  'field-LWW',
  'single-writer',
  'append',
  'cmd',
  'op-stream',
  'n/a',
] as const satisfies readonly ContractConflictClass[]

/**
 * Compile-time proof that {@link CONTRACT_CONFLICT_CLASSES} lists EVERY member of
 * {@link ContractConflictClass}. Resolves to `never` — making the declaration
 * below unassignable, and naming this line — the moment a class is added to the
 * union without being added to the list.
 */
type ExhaustiveConflictClasses =
  Exclude<ContractConflictClass, (typeof CONTRACT_CONFLICT_CLASSES)[number]> extends never
    ? true
    : never
const _conflictClassesAreExhaustive: ExhaustiveConflictClasses = true
void _conflictClassesAreExhaustive

/**
 * Does this input schema have somewhere to put an expected revision?
 *
 * Structural, not nominal, and deliberately TOLERANT: it walks the wrappers the
 * contract tables actually use (`.merge()` produces a plain object; `.optional()`
 * and `.default()` wrap one) and answers `true` the moment it finds the key.
 * Anything it cannot see into — a union, a lazy schema, a refinement — answers
 * `true` as well, because this check exists to catch the contract that plainly
 * has no such field, and a false accusation against an exotic schema would be
 * paid for by whoever wrote the schema rather than by whoever made the mistake.
 */
function inputCarriesExpectedRevision(input: z.ZodTypeAny): boolean {
  const seen = new Set<unknown>()
  const walk = (schema: unknown, depth: number): boolean => {
    if (schema === null || typeof schema !== 'object' || depth > 8 || seen.has(schema)) return true
    seen.add(schema)
    const def = (schema as { _def?: Record<string, unknown> })._def
    if (def === undefined) return true
    // `.optional()`, `.default()`, `.nullable()`, `.effects()` — one wrapped type.
    const inner = def.innerType ?? def.schema
    if (inner !== undefined) return walk(inner, depth + 1)
    const shape = def.shape
    if (typeof shape === 'function') {
      const resolved = (shape as () => Record<string, unknown>)()
      return Object.hasOwn(resolved, 'expectedRevision')
    }
    if (shape !== null && typeof shape === 'object') {
      return Object.hasOwn(shape as Record<string, unknown>, 'expectedRevision')
    }
    // Not an object schema at all — nothing this check can say.
    return true
  }
  return walk(input, 0)
}

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
  // ---------------------------------------------------------------------
  // ADR 1 — the conflict declaration, as a CLOSED PAIR (POD-1250)
  // ---------------------------------------------------------------------
  //
  // The type already says all of this for anything written as a contract literal.
  // These are the semantic half, for the objects that reach a registry without
  // passing through `satisfies CommandContract` — fixtures, wire-decoded rows, and
  // the derived families that build a contract programmatically. Same posture as
  // `visibilityClassOf` beside the required `visibility` field: neither
  // substitutes for the other (D15.2).
  if (!CONTRACT_CONFLICT_CLASSES.includes(contract.conflict)) {
    at(
      `conflict must be one of ${CONTRACT_CONFLICT_CLASSES.join(' | ')} — there is no safe default (ADR 1 D4)`,
    )
  }
  // The `cmd` pair. `arbitration.ts` THROWS on a `cmd` row with no rule rather
  // than waving it through, so a bare `'cmd'` is a row the engine refuses to
  // arbitrate — "otherwise it is a synonym for unchecked".
  if (contract.conflict === 'cmd' && (contract.conflictRule ?? '').trim() === '') {
    at('conflict `cmd` requires conflictRule — a `cmd` row with no rule is unarbitrable (ADR 1 D2)')
  }
  // And the other arm: a rule attached to a class nothing reads it for is a
  // doc-shaped field that starts disagreeing with the behaviour it describes.
  if (contract.conflict !== 'cmd' && contract.conflictRule !== undefined) {
    at('conflictRule belongs to `cmd` rows only — no other class reads it')
  }
  // `exp-rev` MUST BE ABLE TO CARRY THE REVISION IT ARBITRATES ON.
  //
  // ADR 1 D3 / `arbitration.ts`: an `exp-rev` row rejects a mutating command that
  // arrives without an expected revision — `'expected-revision-required'`, and it
  // is default-closed, so it fires on EVERY call rather than on a race. A contract
  // declaring `exp-rev` whose input has nowhere to put one is therefore not a
  // subtle mismatch; it is a command that cannot succeed once POD-1247 wires the
  // engine to these declarations. The issue family merges `EXPECTED_REVISION` into
  // exactly the 24 inputs that declare the class, and this is what keeps the next
  // namespace from declaring the class without the field.
  if (contract.conflict === 'exp-rev' && !inputCarriesExpectedRevision(contract.input)) {
    at(
      'conflict `exp-rev` requires an `expectedRevision` on the input schema — without one the ' +
        'Authority rejects every call as `expected-revision-required` (ADR 1 D3)',
    )
  }
  // THE `'n/a'` GUARD, which is what keeps the written "no row" from becoming
  // the shrug the absent field used to be. `'n/a'` is unfalsifiable from the
  // contract alone — nothing here says whether a handler writes a row — so these
  // check the two facts that PROVE one is written and contradict the claim.
  if (contract.conflict === 'n/a') {
    // ADR 9 D5 A4: a command that creates entities writes replicated rows, and a
    // created row is arbitrated the first time a second writer reaches it.
    if (contract.ownership.creates.length > 0) {
      at(
        'conflict `n/a` contradicts ownership.creates — a command that creates rows has an ADR 1 row',
      )
    }
    // ADR 3 D9: the Outbox queues COMMANDS the authority has not yet seen, which
    // is the mutation path by construction. A query is never queued there.
    if (contract.exposure.includes('outbox')) {
      at('conflict `n/a` contradicts `outbox` exposure — the Outbox queues mutations (ADR 3 D9)')
    }
  }
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
