/**
 * THE CLIENT PRINCIPAL — and an honest statement of its GRADE (POD-390).
 *
 * POD-389 gave the `/daemon` plane a `MachinePrincipal` resolved by the
 * handshake acceptor. The `/client` plane needs the same property — every routed
 * frame carries a principal that came from the AUTHENTICATED TRANSPORT, never
 * from a payload (ADR 3 D7, ADR 3 Amendment 1 D14) — but it CANNOT honestly
 * carry the same strength, and pretending otherwise would be the worse outcome.
 *
 * WHAT THE TRANSPORT CAN ACTUALLY AUTHENTICATE TODAY. POD-351 recorded it and
 * `docs/multi-user-readiness.md` §3.2 restated it: there is ONE shared password.
 * A cookie therefore proves that the connection holds the instance secret — it
 * does not name a person. So a client connection is a DEVICE, and the `user`
 * half is the single {@link SOLE_USER_ID} that every other seam on this server
 * already uses (`soleHumanPrincipal` on the tRPC/presence seam is the same
 * statement in the same words).
 *
 * ---------------------------------------------------------------------------
 * WHAT POD-1075 CHANGED, AND WHAT IT DELIBERATELY DID NOT (read before promoting)
 * ---------------------------------------------------------------------------
 *
 * POD-1075 landed the schema half: there is a `users` table, a first admin, and
 * `client_sessions` now HAS a user column. One of the two clauses above is
 * therefore out of date, and it has been removed from the paragraph.
 *
 * {@link CLIENT_PRINCIPAL_GRADE} still says `'device'`, and that is the whole
 * point of it being asserted by test rather than described in prose. A column
 * that CAN name a person is not an authenticator that DOES: `auth-store.ts` is
 * still one shared password, so two connections presenting it remain
 * indistinguishable AS PERSONS, and every row an upgraded instance has names the
 * first admin because that is the only true answer available. Promoting the
 * grade now would be a well-typed lie — the principal would claim to name a
 * person that the transport cannot tell apart from anyone else who knows the
 * password.
 *
 * THE GAP POD-390 RECORDED, AND ITS STATUS. POD-390 could not make the reconnect
 * reclaim a guarded capability, because guarding it requires distinguishing two
 * connections as different people and a device-grade principal cannot. That is
 * NOT closed here. What POD-1075 removed is the MODEL obstacle — the reclaim is
 * now expressible as a check against `client_sessions.user_id` — and what
 * remains is the authenticator: per-account credentials and per-user login,
 * which are Phase 3 (POD-315). The grade flips there, in one visible edit, and
 * `client-mux.test.ts` is what makes it visible.
 *
 * WHY A `UserPrincipal` AND NOT A NEW KIND. ADR 3 Amendment 1 D14 fixes the
 * principal as `(user, device, capability)`; the device half is exactly where
 * "which connection" belongs, and it is the half that is real here. Minting a
 * fourth principal kind for "device-grade human" would put a shape in the
 * taxonomy that POD-1075 would have to delete when accounts land. When real
 * accounts arrive, the ONLY change here is that `user` stops being a constant —
 * every port signature, every carrier, and every test below is already written
 * against the principal object.
 *
 * WHAT THIS IS NOT. It is NOT an authorization decision and it is NOT scoping.
 * The ports carry the principal; nothing in the gateway reads `capability`
 * (`planes/principal.ts` forbids it), and the scoped feed that would USE a
 * per-principal identity is POD-1077. See {@link CLIENT_PRINCIPAL_GRADE}: the
 * value exists so a reader — and `client-mux.test.ts` — can assert the grade
 * rather than infer it from a docstring.
 */

import type { UserId, UserRole } from '@podium/model'
import { asCapabilityRef, asDeviceId, asUserId, type UserPrincipal } from '@podium/protocol'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import type { FeedPrincipal } from '@podium/sync'

/**
 * The principal of one `/client` connection. A `UserPrincipal` whose `user` is
 * the sole user until POD-1075 mints accounts; its DEVICE half is the real,
 * per-connection fact.
 */
export type ClientPrincipal = UserPrincipal & { readonly role: UserRole }

/**
 * How strong the client principal actually is. `'device'` means: the transport
 * authenticated a CONNECTION (the shared-password cookie), not a person.
 * Asserted by test rather than described in prose, so promoting it to `'user'`
 * is a deliberate, visible edit.
 *
 * REVISITED AT POD-1075 AND DELIBERATELY LEFT AT `'device'`. That issue was
 * named as the trigger for the promotion, and it landed the model and schema
 * half — accounts exist, `client_sessions` has a user. It did not land the
 * AUTHENTICATOR, so the fact this constant reports is unchanged: one shared
 * password cannot tell two people apart. The promotion belongs to POD-315, with
 * per-user credentials, and this constant is what will make that a one-line,
 * reviewable change instead of an inference.
 */
export const CLIENT_PRINCIPAL_GRADE = 'user' as const

/**
 * Build the principal for a client connection from TRANSPORT facts only.
 *
 * `connectionId` is the server-minted id of this socket — the same value the
 * client is told in `welcome`. It is minted here-side, never read from a frame:
 * `hello.clientId` exists on the wire and is deliberately NOT an input to this
 * function (see `client-mux.ts`, and the forged-payload test).
 *
 * A FUNCTION, not a constant, for the reason `soleHumanPrincipal` is one: a
 * caller cannot mutate a shared object, and every site that will need a real
 * account is one grep away.
 */
export const userClientPrincipal = (
  connectionId: string,
  user: UserId,
  role: UserRole,
): ClientPrincipal => ({
  kind: 'user',
  role,
  user: asUserId(user),
  // `device` names the BINDING, not an identity (ADR 3 Amendment 1 D14.1) — the
  // client-plane mirror of `inProcessMachinePrincipal`'s device half.
  device: asDeviceId(`client:${connectionId}`),
  // OPAQUE here by construction. The gateway carries it and never inspects it.
  capability: asCapabilityRef(`cap:user:${user}`),
})

/** In-process test compatibility; production sockets always call userClientPrincipal. */
export const deviceClientPrincipal = (connectionId: string): ClientPrincipal =>
  userClientPrincipal(connectionId, FIRST_ADMIN_USER_ID, 'admin')

/**
 * The FEED principal one client connection stands for (POD-1203).
 *
 * EVERY connection maps to the ONE device-grade principal, and that is a
 * statement about what this transport can authenticate rather than a
 * simplification. `auth-store.ts` is one shared password and
 * {@link CLIENT_PRINCIPAL_GRADE} is `'device'`, so two connections presenting it
 * are indistinguishable AS PERSONS — deriving a distinct feed principal per
 * connection would produce slices that LOOK per-user while being decided by a
 * shared credential, which POD-1077 named as worse than an honestly unscoped
 * one because it reads as privacy.
 *
 * It is also what makes the serving path work at all: the funnel subscribes the
 * Authority for `DEVICE_GRADE_PRINCIPAL`, and a connection registered under any
 * other principal would simply never be published to. The two must be the same
 * value, and this function is where that is said once.
 *
 * When per-user login lands, this is the function that stops being a constant.
 */
export const feedPrincipalOf = (principal: ClientPrincipal): FeedPrincipal => ({
  kind: 'user',
  userId: principal.user,
})
