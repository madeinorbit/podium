/**
 * THE VAULT QUERY — `vault.status`: where the key file is expected, which key
 * wrapped the data key, the vault's state, and why the key cannot be used. Admin
 * people only. Never a secret.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { VaultState } from './registry'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface VaultQuery<I extends z.ZodTypeAny, Out> {
  readonly input: I
  readonly exposure: readonly TransportTag[]
  readonly run: (state: VaultState, input: z.infer<I>) => Out
}

const query = <I extends z.ZodTypeAny, Out>(
  input: I,
  run: (state: VaultState, input: z.infer<I>) => Out,
): VaultQuery<I, Out> => ({ input, exposure: SERVED_ON, run })

export const VAULT_QUERIES = {
  status: query(z.object({}).passthrough().optional(), async (state) => {
    state.requireAdmin()
    return state.vault.status()
  }),
}
