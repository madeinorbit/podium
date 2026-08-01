/**
 * The authenticated principal stamped on every `/client` frame.
 *
 * The user and role come only from the accepted client-session cookie, the
 * device is this server-minted connection id, and the capability is an opaque
 * carrier for feature policy. Payload identity never participates. The gateway
 * derives and carries this tuple; command and visibility policy evaluate it.
 */

import type { UserId, UserRole } from '@podium/model'
import { asCapabilityRef, asDeviceId, asUserId, type UserPrincipal } from '@podium/protocol'
import type { FeedPrincipal } from '@podium/sync'

/**
 * The principal of one `/client` connection. Its device half names the socket
 * binding, not a second user identity.
 */
export type ClientPrincipal = UserPrincipal & { readonly role: UserRole }

/**
 * The accepted cookie resolves a user-owned client session, so the transport
 * principal is user-grade. Tests pin this separately from its object shape.
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
 * A function rather than a shared object keeps every socket's binding distinct.
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

/**
 * The FEED principal one client connection stands for (POD-1203).
 *
 * Feed visibility is keyed by authenticated user. Multiple devices for one
 * person therefore share one authority subscription while retaining distinct
 * connection ids in the gateway registry.
 */
export const feedPrincipalOf = (principal: ClientPrincipal): FeedPrincipal => ({
  kind: 'user',
  userId: principal.user,
})
