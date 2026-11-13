/**
 * WHAT A HARNESS ACTUALLY AUTHENTICATED WITH (credential management §9
 * "Launching", epic plan Task 10).
 *
 * A harness picks its own credential from several places, and a wrong pick
 * still produces a working session that bills someone else. So after the
 * harness starts, the daemon reads back what the harness says it is using and
 * the server records it on the session (`effectiveAuth`). When that answer
 * names another identity than the chosen credential, the session carries
 * `credentialMismatch` with both, until a later start answers as the choice.
 *
 * Nothing here is a secret: a method, a fingerprint (the credential's own, or a
 * sha256 of a login's account name), and a login's e-mail address, which the
 * credential's identity already shows its owner.
 */

import { z } from 'zod'
import { CredentialIdField } from '../ids'

/** How the harness authenticated; `unknown` when it could not say. */
export const EFFECTIVE_AUTH_METHODS = ['api-key', 'subscription', 'token', 'unknown'] as const
export const EffectiveAuthMethod = z.enum(EFFECTIVE_AUTH_METHODS)
export type EffectiveAuthMethod = z.infer<typeof EffectiveAuthMethod>

export const EffectiveAuth = z.object({
  method: EffectiveAuthMethod,
  /** The identity's fingerprint, where the harness's answer gives one. */
  fingerprint: z.string().min(1).max(128).optional(),
  /** A subscription login's account, as the harness names it. */
  email: z.string().min(1).max(320).optional(),
})
export type EffectiveAuth = z.infer<typeof EffectiveAuth>

/** The two identities that disagree: the chosen credential's and the harness's. */
export const CredentialMismatch = z.object({
  chosen: z.object({
    credentialId: CredentialIdField,
    method: EffectiveAuthMethod.optional(),
    fingerprint: z.string().min(1).max(128).optional(),
    email: z.string().min(1).max(320).optional(),
  }),
  reported: EffectiveAuth,
})
export type CredentialMismatch = z.infer<typeof CredentialMismatch>
