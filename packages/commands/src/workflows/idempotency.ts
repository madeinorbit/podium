/**
 * RUN-SCOPED IDEMPOTENCY for the five workflow advances — the framework half of
 * "a duplicate checkpoint delivery must not double-advance a step".
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, PRECISELY
 * ---------------------------------------------------------------------------
 *
 * POD-730 §6 pins it: a `checkpoint` carrying no `stepId` resolves the run's
 * CURRENT step at apply time. A second, byte-identical delivery re-resolves —
 * and by then the current step is the NEXT one, which it completes with the
 * first delivery's summary and evidence. A third finishes the run. A retried
 * RPC or a relay redelivery silently marks work complete that nobody did.
 *
 * ---------------------------------------------------------------------------
 * WHY CONTENT-ADDRESSING CANNOT FIX IT, WHICH IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 * The obvious framework move — key the dedup on the run plus a hash of the
 * input — does not work here, and the reason is worth stating because it is the
 * reason the shape below is what it is:
 *
 *  - Key it on the RESOLVED step and the key MOVES between deliveries. The
 *    first delivery resolves step A, the second resolves step B; two different
 *    keys, no dedup, the double-advance survives untouched. This is the version
 *    that looks like it works.
 *  - Key it on the RAW INPUT and a legitimate second advance is refused: two
 *    consecutive `{status:'complete', summary:''}` checkpoints on different
 *    steps are byte-identical frames and are both intended.
 *
 * At-most-once delivery needs a DELIVERY IDENTITY. There is no derivation of
 * one from the payload, because "the same frame twice" and "the same thing
 * twice" are genuinely indistinguishable from the payload alone. So:
 *
 *   AN ADVANCE EITHER CARRIES A MUTATION ID, OR IT NAMES ITS STEP.
 *
 * Both branches are closed, and the ambiguous frame — neither id nor step — is
 * REFUSED rather than guessed (ADR 9 D4's default-closed instinct applied to
 * delivery). That refusal is the deliberate change to POD-730's §6 BUG row.
 * With a step named, the shipped linear-step guard already refuses the second
 * delivery (`step <id> is not the current linear step`); with a mutation id,
 * the ledger returns the first delivery's recorded result.
 *
 * ---------------------------------------------------------------------------
 * ONE IDEMPOTENCY MECHANISM, NOT A SECOND
 * ---------------------------------------------------------------------------
 *
 * The mutation id is the product's existing one — `OutboxRecord.mutationId`
 * and the authority-side `applied_mutations` ledger, whose contract is already
 * "a replay of an already-applied mutation returns its recorded result instead
 * of re-running". {@link AdvanceIdempotencyPort} is that ledger as a port, so
 * the server can back it with `applied_mutations` and a test with a Map,
 * without this package reaching L3.
 */

/**
 * The recorded-result ledger, as a port (ADR 3 D1: L1 holds no IO).
 *
 * The stored value is opaque to this module — the handler's serialized result.
 * Returning it verbatim, rather than re-running and returning a fresh one, is
 * what makes a replay observationally identical to the original for the caller
 * AND leaves the run untouched for everyone else.
 */
export interface AdvanceIdempotencyPort {
  /** The recorded result of an already-applied advance, or `undefined`. */
  recall(key: string): string | undefined
  record(key: string, result: string): void
}

/**
 * THE RUN-ID RESOURCE SCOPE, in the key.
 *
 * Not decoration. A mutation id is minted by a client, and a client that
 * replays one against a DIFFERENT run must not be handed the first run's
 * recorded result — which is exactly what a bare `mutationId` key would do, and
 * it would look like success. Scoping the key to the run makes the resource the
 * contract declares (`resource: 'session'`, target = the run) and the resource
 * the ledger keys on the same thing, so they cannot drift.
 *
 * The contract name is in the key for the same reason one step down: a `skip`
 * and a `retry` replayed under one mutation id are two different acts.
 */
export function advanceIdempotencyKey(args: {
  readonly contract: string
  readonly runId: string
  readonly mutationId: string
}): string {
  // The separator is an ESCAPED NUL, never a literal one. A literal 0x00 byte
  // makes this file BINARY: `grep -n` and `rg -n` suppress line hits inside it
  // and agent wrappers can answer "no match" for content that is plainly
  // there — which is how a whole module becomes invisible to an audit.
  // `scripts/check-no-nul-bytes.ts` exists for exactly that and caught this
  // file; POD-730 hit the same class of failure from the other side.
  //
  // NUL is still the right SEPARATOR: it cannot occur in a contract name, a
  // run id or a mutation id, so no two distinct triples can collide by one of
  // them containing the delimiter — which a space or a colon cannot promise.
  return `${args.contract}\u0000${args.runId}\u0000${args.mutationId}`
}

/** What an advance carries for delivery identity, as the framework sees it. */
export interface AdvanceDeliveryIdentity {
  /** Client-minted delivery id. A retry replays the SAME id; a new command
   *  mints a new one. That distinction is the client's to make and cannot be
   *  reconstructed here — see this module's header. */
  readonly mutationId?: string | undefined
  /** The step the advance names. Naming it makes the shipped linear-step guard
   *  refuse a second delivery, which is the other closed branch. */
  readonly stepId?: string | undefined
  /** {@link WorkflowAdvanceIdempotency.targetNamedBy} for this command. */
  readonly targetNamedBy: AdvanceTarget
  /**
   * Whether the run this advance moves HAS steps to name.
   *
   * Load-bearing, and the reason it is an input rather than an assumption: a
   * prompt-only (zero-step) run's checkpoint moves the RUN, has no step it
   * could name, and POD-730 §6 pins it as already idempotent. Refusing it for
   * "not naming a step" would be refusing a frame that has no ambiguity and no
   * remedy — the caller could not comply if it wanted to.
   */
  readonly targetHasSteps: boolean
}

/**
 * The message an ambiguous advance is refused with.
 *
 * A CONSTANT because it is asserted verbatim in three places (the contract
 * test, the duplicate-delivery test, and the re-pinned characterization row),
 * and a message kept in sync by hand across three files is a message that
 * drifts. It names both remedies because a caller that hits this needs to know
 * which one applies to it.
 */
export const AMBIGUOUS_ADVANCE_MESSAGE =
  'a workflow advance must name its step or carry a mutation id — an unnamed advance cannot be told apart from a duplicate delivery'

/**
 * Refuse the one frame whose duplicate is undetectable.
 *
 * Called by the dispatcher for every advance BEFORE the handler runs, so the
 * refusal costs nothing and cannot half-apply.
 *
 * THE THREE THINGS IT DOES NOT REFUSE, each of which is a case where either the
 * ambiguity does not exist or the caller could not resolve it:
 *
 *  - an advance that NAMES A STEP but carries no mutation id. This is the
 *    shipped CLI shape, and the linear-step guard already refuses its
 *    duplicate: the first delivery moves the step out of current, so the second
 *    fails with `step <id> is not the current linear step`.
 *  - an advance that carries a MUTATION ID but names no step — the outbox and
 *    RPC-retry shape, closed by the ledger.
 *  - an advance whose TARGET IS THE RUN rather than a step (`targetNamedBy:
 *    'run'`), or whose run has no steps at all. Neither has a step to name, and
 *    neither re-resolves a moving target: a duplicate checkpoint on a
 *    prompt-only run writes the same run status twice, which POD-730 §6 pins as
 *    idempotent in effect.
 *
 * Only the intersection is refused, and the intersection is exactly the pinned
 * defect: a checkpoint against a stepped run, naming no step, carrying no id.
 */
export function assertAdvanceIsDeliverable(identity: AdvanceDeliveryIdentity): void {
  if (identity.targetNamedBy !== 'step') return
  if (!identity.targetHasSteps) return
  if (identity.mutationId === undefined && identity.stepId === undefined) {
    throw new Error(AMBIGUOUS_ADVANCE_MESSAGE)
  }
}

/**
 * What an advance MOVES, and therefore what it must name to be unambiguous.
 *
 * `step` — the advance re-resolves the run's CURRENT step at apply time, which
 * is the resolution that moves between deliveries and the whole source of the
 * defect.
 * `run` — the advance acts on the run as a whole. Its target does not move
 * under a duplicate, so it has nothing to name and is not refused. `adopt` is
 * the only member, and see its contract for what its duplicate DOES do.
 */
export type AdvanceTarget = 'step' | 'run'

/**
 * The contract-side declaration: this command is a run-scoped advance, and the
 * framework must apply the two rules above to it.
 *
 * Carried as DATA on the contract rather than as a set of command names in the
 * dispatcher, so that adding a twelfth advance cannot forget to be idempotent —
 * the declaration travels with the thing it describes, which is the same reason
 * `exposure` lives on the contract instead of in a transport's switch.
 */
export interface WorkflowAdvanceIdempotency {
  /** ADR 3 D2's resource scope for an advance: the RUN it advances. */
  readonly resourceScope: 'run'
  /**
   * What this advance moves, and therefore what it must name.
   *
   * A FIELD rather than a list of command names in the dispatcher, so that a
   * future advance which genuinely cannot name a step says so here, in the
   * open, instead of being special-cased where nobody would find it.
   */
  readonly targetNamedBy: AdvanceTarget
  /** Why this command is an advance — audited like every other rationale. */
  readonly rationale: string
}
