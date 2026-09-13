import {
  ISSUE_PRIVATE_EXECUTION_KEYS,
  toSharedIssueWire,
  toSharedWire,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import type { EntityChangeSpec, LedgerCommitOp } from '@podium/sync'
import { createLogger } from '@podium/logger'

/**
 * **THE PRODUCER HALF OF THE SHARED/PRIVATE SPLIT** — B3/B4's missing first
 * half [PDM-415, contributing to PDM-387].
 *
 * B3 (PDM-135) CLASSIFIED the four private execution keys and said in its own
 * header that classification is not enforcement. B4 (PDM-136) wired the SECOND
 * half — the owner-scoped `issueExecution` sidecar, its feed-visibility arm, and
 * `joinIssueExecution` at five client call sites. The FIRST half, omitting the
 * keys from the broadcast payload, was never wired at any producer, so both
 * shared kinds carried the private values and the sidecar merely DUPLICATED
 * them. PDM-415 measured that at the transport: a member holding only a `read`
 * grant received all four with their real values, on `issue` and
 * `issueProjection`, surviving JSON encoding. This is the omission.
 *
 * ---------------------------------------------------------------------------
 * WHY HERE, AND NOT AT THE PRODUCERS
 * ---------------------------------------------------------------------------
 *
 * `entity: 'issue'` is produced at SIX call sites (`service/core.ts` 1277, 1381,
 * 1453; `service/crud.ts` 1520, 1545, 1643) and `issueProjection` at two more.
 * Masking each is a list somebody has to keep complete, and a SEVENTH call site
 * added later leaks silently with every test still green — which is the exact
 * shape the false-green catalogue records as a census that stops at one caller.
 *
 * Every one of them reaches the change log through `IssueService.deps.ledger`,
 * and that is `IssueAuthorityArbitration.ledger` (built at `relay.ts:1041`,
 * injected at `:1896` and `:1979`).
 *
 * THE BOUND ON "TOTAL BY CONSTRUCTION" [PDM-447]. The property is total over
 * WRITES ROUTED THROUGH THIS WRAPPER, which is what was inspected. It is NOT a
 * claim about every present and future producer, and I wrote it that way first.
 * A producer that obtained the underlying `Ledger` directly rather than through
 * `IssueService.deps.ledger`, or a future kind published by some other seam,
 * lies outside it and this file would never know. What the inspection
 * establishes is that the producers named above ALL route here today; what it
 * cannot establish is that nothing will ever be added that does not.
 *
 * THERE ARE **THREE** DOORS, NOT TWO, AND I GOT THAT WRONG ONCE. The wrapper
 * exposes `commit`, `capture` and `reconcile`. My first attempt masked the two
 * whose bodies are one-line lambdas and read `commit` as being about revision
 * arbitration only — and the PDM-415 witness stayed red with all sixteen values
 * still reaching the grantee, which is what said so. `LedgerCommitOp.changes`
 * returns `EntityChangeSpec[]`, and it is the door the ORDINARY write path uses:
 * `crud.ts`'s `changes: () => [{ entity: 'issue', ... }]` arms go through
 * `commit`, never through `capture`. The door list is the TYPE's three members,
 * not the two whose bodies looked like plumbing.
 *
 * ---------------------------------------------------------------------------
 * WHY `.parse()` AND NOT A STRUCTURAL DELETE
 * ---------------------------------------------------------------------------
 *
 * `toSharedIssueWire` and `toSharedWire` are the classification's own
 * projections, derived from `ISSUE_PRIVATE_KEY_MASK` and therefore from the one
 * key list. A fifth private name added to `ISSUE_PRIVATE_EXECUTION_KEYS` is
 * stripped here with NO edit to this file. A hand-written delete of four named
 * keys would be a second copy of the assumption under test.
 *
 * THE COST OF THAT CHOICE, STATED BECAUSE IT IS REAL: a zod object parse also
 * strips keys the schema does not declare. If a producer ever emitted a field
 * outside `IssueWire`/`IssueProjection`, this would silently drop it as well as
 * the private four. That is not a theoretical worry a comment can settle, so
 * `shared-payload-mask.test.ts` measures it directly — and the first version of
 * that test was VACUOUS for exactly this question [PDM-447]: its fixture was
 * built with `IssueProjection.parse`, which had already stripped every
 * undeclared key before the mask ever ran, so it could not have shown the
 * effect it was written to pin. It now carries three tests instead: masking a
 * producer-shaped payload loses exactly the four; masking a NOT-pre-parsed
 * payload carrying an undeclared field DOES drop that field (the cost is real);
 * and a reconciliation showing `issueRowToProjection` already ends in
 * `IssueProjection.parse`, so the `issueProjection` producer cannot emit such a
 * field. The `issue` kind's guarantee is weaker and is stated there rather than
 * closed.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAILED PARSE STRIPS RATHER THAN THROWS
 * ---------------------------------------------------------------------------
 *
 * Nothing parsed these payloads before, so adding a parse to a live broadcast
 * path introduces a throw where data previously flowed. A throw here would turn
 * a malformed row into a DROPPED PUBLISH, and under `reconcile`'s full-truth
 * contract a dropped row is diffed as a REMOVE — telling every client the issue
 * was deleted. That is a worse failure than the one being fixed.
 *
 * So the fallback omits the private keys STRUCTURALLY and lets the rest through,
 * and it is loud about it. Note the invariant that matters is preserved on BOTH
 * arms: the private keys never leave, whether or not the payload parses. The
 * fallback reads its names from `ISSUE_PRIVATE_EXECUTION_KEYS`, the same
 * constant the schemas are derived from, so it is not a second list.
 */

/** The two broadcast kinds that carry the shared issue payload. `issueExecution`
 *  is deliberately absent: it is the owner-scoped sidecar and masking it would
 *  empty the very row the owner's client re-joins from. */
const log = createLogger('issues.shared-payload-mask')

const SHARED_ISSUE_KINDS = new Set<string>(['issue', 'issueProjection'])

const stripPrivateKeys = (value: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...value }
  for (const key of ISSUE_PRIVATE_EXECUTION_KEYS) delete out[key]
  return out
}

/**
 * One payload, masked for broadcast. Anything that is not a shared issue kind,
 * and anything that is not an object, is returned UNCHANGED — a `remove` carries
 * no value and must not acquire one here.
 */
export function maskSharedIssuePayload(entity: string, value: unknown): unknown {
  if (!SHARED_ISSUE_KINDS.has(entity)) return value
  if (typeof value !== 'object' || value === null) return value
  try {
    return entity === 'issue'
      ? toSharedIssueWire(value as Parameters<typeof toSharedIssueWire>[0])
      : toSharedWire(value as Parameters<typeof toSharedWire>[0])
  } catch (err) {
    // NOT a rethrow — see the header. The private keys still come off.
    log.warn(
      'a shared issue payload did not parse as its shared projection — stripping the private execution keys structurally and publishing the rest',
      { err, entity },
    )
    return stripPrivateKeys(value as Record<string, unknown>)
  }
}

/**
 * A `Ledger.commit` op whose declared changes are masked.
 *
 * The op's `changes` is a CALLBACK taking the write's result, so the mask wraps
 * it rather than mapping a value: the specs do not exist until the write has
 * run. `async` on the wrapper because the callback may return a promise, and
 * awaiting a non-promise is harmless.
 */
export function maskCommitOp<T>(op: LedgerCommitOp<T>): LedgerCommitOp<T> {
  return { ...op, changes: async (result) => maskChangeSpecs(await op.changes(result)) }
}

/** `Ledger.capture` specs, masked. Specs for other kinds pass through untouched
 *  and by identity, so this is a no-op for every non-issue writer sharing the
 *  ledger. */
export function maskChangeSpecs(specs: EntityChangeSpec[]): EntityChangeSpec[] {
  return specs.map((spec) => {
    if (!SHARED_ISSUE_KINDS.has(spec.entity) || spec.value === undefined) return spec
    return { ...spec, value: maskSharedIssuePayload(spec.entity, spec.value) }
  })
}

/** `Ledger.reconcile` rows, masked. The full-truth list for one kind, so the
 *  kind is decided once for the whole batch rather than per row. */
export function maskReconcileRows(
  entity: MetadataEntityKind,
  rows: { id: string; value: unknown }[],
): { id: string; value: unknown }[] {
  if (!SHARED_ISSUE_KINDS.has(entity)) return rows
  return rows.map((row) => ({ ...row, value: maskSharedIssuePayload(entity, row.value) }))
}
