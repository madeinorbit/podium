/**
 * WHAT A SESSION RUNS ON, AS IT CROSSES THE WIRE (credential management §8,
 * "What crosses the wire").
 *
 * A message that starts a process for a session carries the credential in this
 * one field, never mixed into its plain environment values: the credential id,
 * the delivery the server's resolver chose and, for `env`, the secret. The
 * server sends it only to a daemon that offered {@link CAP_SESSION_ACCESS},
 * over a connection the server judged safe. The daemon keeps it in memory for
 * the life of the session and never writes it down.
 *
 * Every message type that can carry this field is excluded from logging by
 * type (`ACCESS_CARRYING_CONTROL_TYPES` in `./control`), not by field name.
 */

import { SessionIdField } from '@podium/model'
import { z } from 'zod'

/** A daemon that offers this keeps a session's access in memory and applies it
 *  at every process start for that session; one that does not is refused. */
export const CAP_SESSION_ACCESS = 'session.access.v1'

export const AccessDelivery = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('env'),
    variable: z.string().min(1),
    secret: z.string().min(1),
  }),
  z.object({ kind: z.literal('home'), homeId: z.string().min(1) }),
])
export type AccessDelivery = z.infer<typeof AccessDelivery>

export const AccessField = z.object({
  credentialId: z.string().min(1),
  delivery: AccessDelivery,
})
export type AccessField = z.infer<typeof AccessField>

/**
 * Server → daemon after a reconnect: the access of a live session, sent again
 * because a restarted daemon holds none. A turn that starts before it arrives
 * waits for it; it never runs without it.
 */
export const SessionAccessRefreshMessage = z.object({
  type: z.literal('sessionAccessRefresh'),
  sessionId: SessionIdField,
  access: AccessField,
})
export type SessionAccessRefreshMessage = z.infer<typeof SessionAccessRefreshMessage>
