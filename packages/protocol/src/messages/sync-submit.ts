/**
 * THE SYNC WRITE ENTRY POINT'S WIRE SHAPES — `sync.submit` (ADR 12 D2, POD-6273).
 *
 * Every write to synced data enters the server through one procedure. Its input is
 * the envelope the client outbox already builds (`OutboxEnvelope` in
 * `@podium/sync`), and its reply carries the command's result together with a
 * RECEIPT: the change-log position the client's replica must reach before the
 * write's optimistic value may leave the outbox (ADR 12 D7, plan Decision 1).
 *
 * The receipt is part of the reply, not a header: one endpoint means no header
 * plumbing, no CORS exposure and no fetch wrapping (plan Decision 2).
 *
 * These schemas live in `@podium/protocol` because the web, mobile and CLI clients
 * all read the reply. `@podium/sync` declares the same envelope and refusal as
 * TypeScript types for its kernel; the server's entry point asserts at compile time
 * that the two agree, so neither can drift without the build saying so.
 */

import { MutationIdField } from '@podium/model'
import { z } from 'zod'

/**
 * A change-log position with the feed identity it belongs to (ADR 2 D1).
 *
 * `seq` is the change-log HEAD after the call's last commit, for every reply,
 * a no-op and a replay included (plan Decision 1). A bare integer is never a
 * cursor: an epoch is compared by equality only (`feed/identity.ts`).
 */
export const WriteReceipt = z.object({
  feedId: z.string().min(1),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
})
export type WriteReceipt = z.infer<typeof WriteReceipt>

/**
 * One submitted command: the outbox envelope (`OutboxEnvelope`), field for field.
 *
 * There is no identity on it (ADR 3 D7): the principal comes only from the
 * authenticated transport. `confirmed` is the user's out-of-scope confirmation
 * (ADR 3 D8 outcome 3), a decision rather than an identity, which is why it may
 * ride here.
 */
export const SyncSubmitInput = z.object({
  mutationId: MutationIdField,
  command: z.string().min(1),
  version: z.number().int().positive(),
  input: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
  confirmed: z.literal(true).optional(),
})
export type SyncSubmitInput = z.infer<typeof SyncSubmitInput>

/**
 * Why the server refused a submit — `AuthorityRefusal` in `@podium/sync`, the
 * union the outbox normalises into a durable reason. `unauthorized` and
 * `target-not-found` stay separate on the wire for telemetry; the outbox collapses
 * them into one stored code so no existence fact escapes (ADR 3 Amendment D20).
 * `details` on `invalid` are paths in the caller's OWN input.
 *
 * `message` is the handler's own words for a refusal it decided ("a profile named
 * x already exists"), which the old per-command route showed and a caller waiting
 * on `sync.submit` shows too (POD-6412). It is set ONLY from a handler's refusal,
 * after both permission checks passed, never by the coarse or target check, so it
 * tells a refused caller nothing it could not already see. Optional, and the arms
 * are not strict, so an older reader drops it.
 */
const message = z.string().optional()
export const SyncSubmitRefusal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unauthorized'), message }),
  z.object({ kind: z.literal('target-not-found'), message }),
  z.object({ kind: z.literal('conflict'), message }),
  z.object({ kind: z.literal('invalid'), details: z.array(z.string()).optional(), message }),
  z.object({ kind: z.literal('confirmation-required'), message }),
])
export type SyncSubmitRefusal = z.infer<typeof SyncSubmitRefusal>

/**
 * The entry point's reply.
 *
 * - `applied`: the command ran (or, with `replayed: true`, had already run under
 *   this `mutationId` and its recorded result is returned without running again).
 *   `receipt` is the head after the commit.
 * - `rejected`: a definitive refusal. Nothing was written. A transient failure is
 *   never a `rejected` reply; it is a transport error the outbox retries.
 */
export const SyncSubmitReply = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('applied'),
    result: z.unknown(),
    receipt: WriteReceipt,
    replayed: z.boolean(),
  }),
  z.object({
    outcome: z.literal('rejected'),
    refusal: SyncSubmitRefusal,
  }),
])
export type SyncSubmitReply = z.infer<typeof SyncSubmitReply>
