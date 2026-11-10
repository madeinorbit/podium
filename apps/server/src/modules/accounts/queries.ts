/**
 * THE ACCOUNT QUERIES — `list` and the admin's `keys` directory.
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
import { asAccountId, asUserId, type MachineId } from '@podium/model'
import { z } from 'zod'
import { accountViews } from '../../accounts'
import { SHARED_WITH_EVERYONE } from '../../store/accounts'
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
  /** Owner, masked identity and sharing only; credentials never leave the server. */
  keys: query(z.object({}), async (state) => {
    state.requireKeyAdmin()
    return (await state.accounts.summaries()).map((row) => ({
      owner: row.ownerUserId,
      id: row.accountKey,
      provider: row.provider,
      kind: row.kind,
      ...(row.identity ? { identity: row.identity } : {}),
      sharing: {
        everyone: row.sharedWith.includes(SHARED_WITH_EVERYONE),
        users: row.sharedWith.filter((grantee) => grantee !== SHARED_WITH_EVERYONE),
      },
    }))
  }),
  // POD-419 moved the provider keys out of the settings blob into the
  // server-only keyed store, narrowing `accountViews` from the whole blob to a
  // resolver for the ONE member it reads. POD-314 derived this list from a base
  // that predated that, so the derived form is repointed here rather than the
  // blob read being reinstated — taking either side wholesale would have
  // silently undone one of the two.
  list: query(noInput, async (state) => {
    // ONE MEMBER'S HUB (POD-6300, design §2.5). The caller's own managed
    // connections or explicitly shared keys; native logins on machines in their
    // OWN custody (a machine's native logins belong to the person who looks after
    // it). Nothing of another
    // member's private connection reaches this list, admins included.
    const viewer = asUserId(state.callerUserId)
    const standing = await state.machineStanding()
    const custody = new Set([...standing].filter(([, s]) => s === 'custody').map(([id]) => id))
    // ONE SOURCE (POD-4832): the online service listing — the same online +
    // inventory the picker (`codexLoginMachines` / `machinesForAgent`) and the
    // pane (`agentLoginCondition`) read — not the store copy, which includes
    // offline stale rows (a daemon that has not reported since its login
    // lapsed) and pending stale rows (the previous connection's inventory
    // before the new daemon reports). A stale offline `in` must not keep the
    // hub `connected` when no online machine reports the login.
    const serviceMachines = await state.machineService.listMachines()
    const ownOnline = serviceMachines.filter((machine) => machine.online && custody.has(machine.id))
    // Served descriptors across the fleet for the provider labels (POD-4529):
    // `accountViews` resolves these over the bundled fallback, so an older
    // daemon that reported no descriptors still renders. Labels only, so every
    // online machine contributes, not just the viewer's.
    const served = (
      await Promise.all(
        serviceMachines
          .filter((machine) => machine.online)
          .map(async (machine) => state.machineService.harnessDescriptorsFor(machine.id) ?? []),
      )
    ).flat()
    // Which native login this viewer's server AI would spend (POD-4750) — one
    // call per list; rows below match its harness by equality. A refusal (no
    // usable login for this viewer) leaves every row as the catalog describes it.
    const serverAi = state.resolveCodexServerAi
      ? await state.resolveCodexServerAi().catch(() => undefined)
      : undefined
    // The viewer's D11 choices and how their ticked logins' copies went (POD-6301).
    const choiceKey = (harness: string, fingerprint: string) => `${harness}\u0000${fingerprint}`
    const ticked = new Set(
      (await state.accounts.optInsFor(viewer))
        .filter((choice) => choice.enabled)
        .map((choice) => choiceKey(choice.harness, choice.fingerprint)),
    )
    const keptOn = new Map<string, MachineId[]>()
    for (const transfer of await state.accounts.transfersFor(viewer)) {
      if (transfer.outcome !== 'preserved' || !custody.has(transfer.machineId)) continue
      const key = choiceKey(transfer.harness, transfer.fingerprint)
      keptOn.set(key, [...(keptOn.get(key) ?? []), transfer.machineId])
    }
    const nameOf = new Map(serviceMachines.map((machine) => [machine.id, machine.name]))
    const sends = await state.accounts.sendsOf(viewer)
    const sharedMachines = [...standing]
      .filter(([, s]) => s === 'use')
      .map(([id]) => ({ id, name: nameOf.get(id) ?? id }))
    return await Promise.all(
      (
        await accountViews(
          state.accounts,
          viewer,
          ownOnline as unknown as Parameters<typeof accountViews>[2],
          served,
        )
      ).map(async (account) => {
        if (account.source === 'managed') {
          if (account.credentialSource !== 'stored') return account
          // Where the viewer's own connection may run beyond their own machines,
          // and every send recorded for it (POD-6699), usable there or not.
          const recorded = sends.get(asAccountId(account.id)) ?? []
          const sent = new Set(recorded.map((send) => send.machineId))
          return {
            ...account,
            sentTo: sharedMachines.filter((machine) => sent.has(machine.id)),
            sendableTo: sharedMachines.filter((machine) => !sent.has(machine.id)),
            sends: recorded.map((send) => ({
              id: send.machineId,
              name: nameOf.get(send.machineId) ?? send.machineId,
              sentAt: send.sentAt,
            })),
          }
        }
        if (!account.harness) return account
        const harness = account.harness as import('@podium/model').HarnessAgent
        const attempt = state.nativeLogin.attempt(viewer, harness)
        const loginMachines = ownOnline
          .filter((machine) =>
            machine.inventory?.agents.some((agent) => agent.kind === harness && agent.installed),
          )
          .map((machine) => ({ id: machine.id, name: machine.name }))
        const choice = account.identityFingerprint
          ? choiceKey(harness, account.identityFingerprint)
          : undefined
        return {
          ...account,
          ...(choice
            ? {
                useOnMyMachines: ticked.has(choice),
                keptOn: (keptOn.get(choice) ?? []).map((id) => ({
                  id,
                  name: nameOf.get(id) ?? id,
                })),
              }
            : {}),
          loginRequired:
            account.status === 'not-configured' || state.nativeLogin.isRequired(harness, custody),
          loginMachines,
          ...(attempt ? { loginAttempt: attempt } : {}),
          // Which native login this viewer's server AI would spend (POD-4750):
          // resolved once above; rows match the returned harness by equality.
          // The last refusal text (POD-4805) rides along when the issue
          // assistant has recorded one — including when no machine could be
          // picked, so Settings still says why.
          ...(serverAi && harness === serverAi.harness
            ? {
                serverAi: {
                  ...(serverAi.machineId !== undefined ? { machineId: serverAi.machineId } : {}),
                  ...(serverAi.machineName !== undefined
                    ? { machineName: serverAi.machineName }
                    : {}),
                  ...(serverAi.lastError !== undefined ? { lastError: serverAi.lastError } : {}),
                },
              }
            : {}),
        }
      }),
    )
  }),
} as const

export type AccountQueryName = keyof typeof ACCOUNT_QUERIES
