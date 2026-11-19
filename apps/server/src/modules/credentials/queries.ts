/**
 * THE CREDENTIAL QUERY — `credentials.list`: the credentials the caller owns or
 * was given, each with what the caller may do with it. Never a secret: each row is
 * built field by field and parsed through `CredentialView`, which has no field
 * that could hold one.
 *
 * Eight reads whatever the number of credentials: the caller's own, the
 * placements of theirs still on a machine, the machines' inventories, the grants to
 * the caller or to all members, those credentials, the grants of every listed
 * credential (own ones too, for `sharedWith`), the granters' standing, and the
 * allowed machines.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { CredentialsState } from './commands'
import { listCredentials } from './list'
import { withNativeLoginViews } from './native-login-views'

export { listCredentials }

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface CredentialQuery<I extends z.ZodTypeAny, Out> {
  readonly input: I
  readonly exposure: readonly TransportTag[]
  readonly run: (state: CredentialsState, input: z.infer<I>) => Out
}

const query = <I extends z.ZodTypeAny, Out>(
  input: I,
  run: (state: CredentialsState, input: z.infer<I>) => Out,
): CredentialQuery<I, Out> => ({ input, exposure: SERVED_ON, run })

export const CREDENTIAL_QUERIES = {
  list: query(z.object({}).passthrough().optional(), async (state) => {
    const views = await listCredentials(state.store, state.callerUserId)
    return state.native ? withNativeLoginViews(views, state.native, state.callerUserId) : views
  }),
  /** The background role's native transport and last refusal, independently of credential identity. */
  serverAiStatus: query(z.object({}).passthrough().optional(), async (state) =>
    state.resolveServerAi ? state.resolveServerAi().catch(() => undefined) : undefined,
  ),
  /** Where the caller's sign-in on a machine stands (§6 way 2): waiting, signed in as an account, or failed. */
  signInStatus: query(z.object({ credentialId: z.string().min(1).max(100) }), (state, input) =>
    state.signIn
      ? state.signIn.status(input.credentialId, state.callerUserId)
      : ({
          state: 'failed',
          reason: 'Signing in on a machine is not available on this server.',
        } as const),
  ),
  /** Where the caller's ChatGPT sign-in attempt stands (§11): waiting, signed in, or failed. */
  chatgptSignInStatus: query(z.object({ attemptId: z.string().min(1).max(100) }), (state, input) =>
    state.chatgpt
      ? state.chatgpt.status(input.attemptId, state.callerUserId)
      : ({
          state: 'failed',
          reason: 'Sign in with ChatGPT is not available on this server.',
        } as const),
  ),
}
