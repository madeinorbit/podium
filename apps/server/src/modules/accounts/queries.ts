/**
 * THE ACCOUNT QUERY — `list`.
 *
 * Native CLI logins on this machine (observed read-only) plus the managed
 * credentials Podium holds. Read at CALL TIME — native identity and quota drift,
 * so it is never cached as truth. NB: never returns a credential, only its
 * masked `identity`.
 *
 * A table rather than a read contract: a `visibility` class describes what a
 * command WRITES and a read writes nothing.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import { accountViews } from '../../accounts'
import type { AccountState } from './registry'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface AccountQuery<I extends z.ZodTypeAny, Out> {
  readonly input: I
  readonly exposure: readonly TransportTag[]
  readonly run: (state: AccountState, input: z.infer<I>) => Out
}

const query = <I extends z.ZodTypeAny, Out>(
  input: I,
  run: (state: AccountState, input: z.infer<I>) => Out,
): AccountQuery<I, Out> => ({ input, exposure: SERVED_ON, run })

const noInput = z.object({}).passthrough().optional()

export const ACCOUNT_QUERIES = {
  // POD-419 moved the provider keys out of the settings blob into the
  // server-only keyed store, narrowing `accountViews` from the whole blob to a
  // resolver for the ONE member it reads. POD-314 derived this list from a base
  // that predated that, so the derived form is repointed here rather than the
  // blob read being reinstated — taking either side wholesale would have
  // silently undone one of the two.
  list: query(noInput, (state) =>
    accountViews(
      (provider) => state.settings.apiKeyFor(provider),
      state.accounts,
      state.machines.listMachines(),
    ).map((account) => {
      if (account.source !== 'native' || !account.harness) return account
      const harness = account.harness as import('@podium/model').HarnessAgent
      const attempt = state.nativeLogin.attempt(harness)
      const loginMachines = state.machineService
        .listMachines()
        .filter(
          (machine) =>
            machine.online &&
            machine.inventory?.agents.some((agent) => agent.kind === harness && agent.installed),
        )
        .map((machine) => ({ id: machine.id, name: machine.name }))
      return {
        ...account,
        loginRequired: account.status === 'not-configured' || state.nativeLogin.isRequired(harness),
        loginMachines,
        ...(attempt ? { loginAttempt: attempt } : {}),
      }
    }),
  ),
} as const

export type AccountQueryName = keyof typeof ACCOUNT_QUERIES
