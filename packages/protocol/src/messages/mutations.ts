import { z } from 'zod'
import { MachineId, MutationId } from '../ids'
import { MetadataChange } from './sync'

/**
 * The generic client→authority write envelope + result contract for the P2
 * replication ledger [spec:SP-3fe2] — the generalization of what the issue
 * write path already does concretely today (packages/sync/src/
 * upstream-forwarder.ts): idempotent mutations flow toward the authority,
 * and every attempt lands in exactly one of three outcomes — applied,
 * definitively rejected, or durably queued behind a transport failure.
 *
 * P1 is additive-only: nothing sends these frames yet. The P3 command
 * registry supplies the `command` vocabulary and input validation.
 */
export const MutationEnvelope = z.object({
  /** Client-generated idempotency key. Doubles as the outbox PK and the
   *  authority-side applied_mutations dedup key, exactly like the forwarder's
   *  `input.mutationId` — a replay of an already-applied mutation returns its
   *  recorded result instead of re-running. */
  mutationId: MutationId,
  /** Dotted command name, e.g. 'issues.close'. The P3 registry validates it
   *  (and the input) — the envelope itself only requires non-empty. */
  command: z.string().min(1),
  input: z.unknown(),
  origin: z.object({
    actor: z.string().min(1),
    machineId: MachineId.optional(),
  }),
  /** ISO timestamp, informational only — NEVER used for conflict resolution
   *  (the authority's oplog seq is the one ordering source). */
  sentAt: z.string().datetime(),
})
export type MutationEnvelope = z.infer<typeof MutationEnvelope>

/** The three terminal states of a mutation attempt. Kept as a const list so
 *  classification tables can be checked total over it (message-class.ts style). */
export const MUTATION_RESULT_KINDS = ['applied', 'rejected', 'queued'] as const
export type MutationResultKind = (typeof MUTATION_RESULT_KINDS)[number]

/**
 * Result of submitting a MutationEnvelope — a discriminated union mirroring
 * the upstream-forwarder's three outcomes EXACTLY:
 *
 * - `applied` — the authority ran the command and recorded it (the forwarder's
 *   `await this.call(...)` resolving). May echo the oplog rows the mutation
 *   produced so the submitter can advance its cursor without a round trip.
 * - `rejected` — DEFINITIVE: the authority responded and refused (the
 *   forwarder's `isDefinitiveRejection` — a structured error, not a transport
 *   failure). `retryable: false` is implied: replaying would just replay the
 *   rejection, so a queued replay that lands here is poison and must be
 *   dropped (forwarder drain's poison-drop + onPoisoned path), never retried.
 * - `queued` — transport failure: the authority was unreachable, the mutation
 *   was durably outboxed for a serial FIFO replay on reconnect (the
 *   forwarder's `{ queued: true }` + upstream_outbox enqueue). Not a terminal
 *   verdict on the mutation itself — replay resolves it to applied/rejected.
 *
 * Adapter note: today's forwarder THROWS definitive rejections to the caller
 * rather than returning them; mapping that throw into the `rejected` arm (and
 * a resolved value into `applied.result`) is the adapter's job when the
 * ledger/registry adopt this envelope — the semantics mirrored here are the
 * outcome classes, not the throw-vs-return calling convention.
 */
export const MutationResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('applied'),
    /** The command's return value (the forwarder resolves the hub's arbitrary
     *  result through unchanged — e.g. the created issue). `unknown` here;
     *  the P3 command registry types it per-command via CommandDef's Out. */
    result: z.unknown().optional(),
    /** Optional oplog echo: the MetadataChange rows this mutation appended. */
    changes: z.array(MetadataChange).optional(),
  }),
  z.object({
    kind: z.literal('rejected'),
    /** The authority's rejection message (surfaced to the user — the queued
     *  optimistic edit is LOST, see forwarder onPoisoned / issue #25). */
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('queued'),
  }),
])
export type MutationResult = z.infer<typeof MutationResult>
