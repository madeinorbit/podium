/**
 * THE PER-USER CLIENT SESSION — a device that resolves to a person (POD-1075).
 *
 * ADR 9 D1.3: *"Client sessions become per-user. A client session is still a
 * DEVICE; it now RESOLVES TO A USER."* ADR 1's matrix carries it as
 * `ROW.perUserClientSession`, whose `sites` column records what was true before
 * this issue: *"`client_sessions` — `(token_hash, created_at, expires_at)`, NO
 * user column today"*.
 *
 * ---------------------------------------------------------------------------
 * DEVICE AND PERSON BECOME TWO ANSWERS, NOT ONE
 * ---------------------------------------------------------------------------
 *
 * That is the entire point of the column, and it is worth saying plainly because
 * the shape is small enough to look like bookkeeping. Before it, "which
 * connection is this?" and "who is this?" had one answer — the cookie — and
 * anything that wanted to distinguish two people had nothing to read. After it,
 * `device` names the binding and `user` names the person, which is ADR 9 D1's
 * `(user, device, capability)` triple with its first two members finally
 * separable in storage.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT MAKE TRUE YET, STATED SO NOBODY READS IT AS DONE
 * ---------------------------------------------------------------------------
 *
 * A column that can name a person is not an authenticator that CAN name one.
 * There is still ONE shared password (`packages/runtime/src/auth-store.ts`), so
 * two connections presenting it are still indistinguishable AS PERSONS — the
 * `user` on every row an upgraded instance has is the first admin, because that
 * is the only true answer available. `apps/server/src/gateway/
 * client-principal.ts` therefore still asserts `CLIENT_PRINCIPAL_GRADE =
 * 'device'`, and it is correct to: promoting it before per-user credentials
 * exist would be a well-typed lie, and the assertion exists precisely so the
 * promotion is a visible edit rather than a silent one.
 *
 * Per-account credentials, per-user login, and the guarded reconnect-reclaim
 * POD-390 could not build under a device-grade principal are Phase 3 (POD-315).
 * This issue supplies the model and schema half that makes them expressible.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS ABSENT, AND THAT IS THE SECRET RULE
 * ---------------------------------------------------------------------------
 *
 * The row is keyed by a token HASH; the token preimage is `secret-value` and
 * never replicates (ADR 1 D6, and ADR 9 D3's `secrets` class names *"client auth
 * token preimages"* explicitly). There is no `token` field here and there must
 * never be one — this schema describes the durable row, and `secret-presence`
 * (the matrix's cell for it) means a replica may know a device session EXISTS
 * without ever holding the material that would let it act as one.
 */

import { z } from 'zod'
import { DeviceIdField, UserIdField } from '../ids'

/**
 * One authenticated client session — ADR 1 matrix row `per-user-client-session`.
 *
 * The matrix classes this row `per-user-state` and its `owner` resolves
 * `the-user-in-the-key`, which is why {@link ClientSessionAggregate} composes
 * the user and device halves directly rather than `Ownership`: a device session
 * belongs to exactly one person by construction, is NEVER grantable (ADR 9 D3
 * rule 4 — there is no "share my logged-in device" verb), and an owner column
 * that could differ from `user` would make that shareable by accident.
 *
 * It deliberately does NOT compose `perUserKey`. That fragment keys state a
 * person holds ABOUT AN ENTITY (`readAt` on a session, a pin on a repo); a
 * client session is not about an entity — the device IS the row's second half.
 * Forcing it through `perUserKey` would have meant calling the device an
 * `entityId`, which is the kind of well-typed lie the branded-id work exists to
 * stop.
 */
export const ClientSessionAggregate = z.object({
  /** The transport binding — WHICH DEVICE. Server-minted at login; today the
   *  primary key is the token hash and this names the same row. */
  device: DeviceIdField,
  /** WHO. On an upgraded instance this is the first admin for every pre-existing
   *  row: the migration ADOPTS existing sessions rather than invalidating them,
   *  so nobody is logged out by an upgrade. */
  user: UserIdField,
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type ClientSessionAggregate = z.infer<typeof ClientSessionAggregate>
