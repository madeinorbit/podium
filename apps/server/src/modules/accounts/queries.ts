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
 *
 * ---------------------------------------------------------------------------
 * WHOSE ROWS (PDM-271)
 * ---------------------------------------------------------------------------
 *
 * The NATIVE half of this read is a statement about a person's private
 * execution: which harness account is logged in, on which named machines, and
 * whether a login is in flight right now. Until PDM-271 the body consulted no
 * principal at all, so every caller received every machine's logins — and
 * `trpc.ts` had been putting `callerUserId` into this state since the family was
 * derived, so the principal was present and simply unread.
 *
 * Every native fact below is now resolved against ONE answer,
 * {@link machineIdsUsableBy}, taken once per call:
 *
 *  - the machine records `accountViews` builds native rows from,
 *  - the login TARGETS offered for `accounts.login`,
 *  - whether a login is required,
 *  - and the in-flight attempt, which `NativeLoginService` now tracks per owner.
 *
 * Resolving it once is the load-bearing part. The two machine reads here used to
 * be independent listings of the whole fleet, and gating one of them would have
 * left the other answering the same question differently — the shape where a
 * scoped read and an unscoped sibling both survive review.
 *
 * THE MANAGED HALF IS NOT SCOPED HERE, and saying so is deliberate. The
 * `accounts` table has no owner column and its ids are per-provider singletons
 * derived server-side (`managed:anthropic`), so there is no per-person managed
 * row to return; `accounts.connect` DECLARES the row owned by the human it was
 * written on behalf of, and that ownership is not stored. Closing that is a
 * schema change on B2's credential boundary and is filed rather than done here.
 */

import type { TransportTag } from '@podium/commands'
import type { HarnessAgent } from '@podium/model'
import { z } from 'zod'
import { accountViews } from '../../accounts'
import { machineIdsUsableBy } from './machine-scope'
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
  list: query(noInput, async (state) => {
    const usable = await machineIdsUsableBy(state.machineService, state.callerUserId)
    return await Promise.all((await accountViews(
      async (provider) => await state.settings.apiKeyFor(provider),
      state.accounts,
      (await state.machines.listMachines()).filter((machine) => usable.has(machine.id)),
    )).map(async (account) => {
      if (account.source !== 'native' || !account.harness) return account
      const harness = account.harness as HarnessAgent
      const attempt = state.nativeLogin.attempt(harness, state.callerUserId)
      const loginMachines = (await state.machineService
        .listMachines())
        .filter(
          (machine) =>
            usable.has(machine.id) &&
            machine.online &&
            machine.inventory?.agents.some((agent) => agent.kind === harness && agent.installed),
        )
        .map((machine) => ({ id: machine.id, name: machine.name }))
      return {
        ...account,
        loginRequired:
          account.status === 'not-configured' || state.nativeLogin.isRequired(harness, usable),
        loginMachines,
        ...(attempt ? { loginAttempt: attempt } : {}),
      }
    }))
  }),
} as const

export type AccountQueryName = keyof typeof ACCOUNT_QUERIES
