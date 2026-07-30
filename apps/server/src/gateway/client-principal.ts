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
 * `docs/multi-user-readiness.md` §3.2 restates it: there is ONE shared password
 * and `client_sessions` has no user column. A cookie therefore proves that the
 * connection holds the instance secret — it does not name a person. So a client
 * connection is a DEVICE, and the `user` half is the single
 * {@link SOLE_USER_ID} that every other seam on this server already uses
 * (`soleHumanPrincipal` on the tRPC/presence seam is the same statement in the
 * same words).
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

import { SOLE_USER_ID } from '@podium/model'
import { asCapabilityRef, asDeviceId, asUserId, type UserPrincipal } from '@podium/protocol'

/**
 * The principal of one `/client` connection. A `UserPrincipal` whose `user` is
 * the sole user until POD-1075 mints accounts; its DEVICE half is the real,
 * per-connection fact.
 */
export type ClientPrincipal = UserPrincipal

/**
 * How strong the client principal actually is. `'device'` means: the transport
 * authenticated a CONNECTION (the shared-password cookie), not a person. Asserted
 * by test rather than described in prose, so promoting it to `'user'` when
 * POD-1075 lands is a deliberate, visible edit.
 */
export const CLIENT_PRINCIPAL_GRADE = 'device' as const

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
export const deviceClientPrincipal = (connectionId: string): ClientPrincipal => ({
  kind: 'user',
  user: asUserId(SOLE_USER_ID),
  // `device` names the BINDING, not an identity (ADR 3 Amendment 1 D14.1) — the
  // client-plane mirror of `inProcessMachinePrincipal`'s device half.
  device: asDeviceId(`client:${connectionId}`),
  // OPAQUE here by construction. The gateway carries it and never inspects it.
  capability: asCapabilityRef('cap:operator'),
})
