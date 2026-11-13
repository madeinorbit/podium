/**
 * WHAT THE HARNESS SAYS IT AUTHENTICATED WITH (credential management §9
 * "Launching", epic plan Task 10).
 *
 * Daemon → server, once after a harness process for a session started: the
 * harness's own answer to "which login are you on", read with the session's
 * exact environment. The server records it on the session (`effectiveAuth`)
 * and compares it with the credential the session was given.
 *
 * NEVER A SECRET. `delivered` says whether the value the harness read is the
 * one the session's access field delivered, compared on the daemon; the value
 * itself never leaves it. `identity` is a subscription login's account name and
 * its sha256, which the credential's own identity already shows its owner.
 */

import { EffectiveAuthMethod, SessionIdField } from '@podium/model'
import { z } from 'zod'

export const SessionAuthMessage = z.object({
  type: z.literal('sessionAuth'),
  sessionId: SessionIdField,
  method: EffectiveAuthMethod,
  /** Where the harness says it took the credential from (an env variable's
   *  name, `login`), when it says. */
  source: z.string().min(1).max(64).optional(),
  /** The harness read exactly the value the session's access delivered. Absent:
   *  nothing was delivered, or the harness did not say where it read from. */
  delivered: z.boolean().optional(),
  identity: z
    .object({
      email: z.string().min(1).max(320).optional(),
      fingerprint: z.string().min(1).max(128).optional(),
    })
    .optional(),
})
export type SessionAuthMessage = z.infer<typeof SessionAuthMessage>
