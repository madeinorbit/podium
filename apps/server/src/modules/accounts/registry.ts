/**
 * THE JOIN — the account contracts (L1) paired with the L3 code that
 * implements them, per ADR 3 D1.
 *
 * What is left of the account family is the machines' own (native) logins: the
 * login terminal and the D11 tick. The stored provider keys it once held are
 * credentials now (credential management plan Task 21); POD-7065 moves these
 * two onto the Credentials page's found-login rows.
 */

import {
  ACCOUNT_CONTRACT_NAMES,
  ACCOUNT_CONTRACTS,
  type AccountContractName,
  type AnyCommandContract,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import { asUserId, type HarnessAgent, type MachineId, type UserId } from '@podium/model'
import type { z } from 'zod'
import type { RegistryModules, SessionRegistry } from '../../relay'
import type { PlainTargetCheck } from '../plain-command/entry'

/** Exactly what the account family reaches, named. */
export interface AccountState {
  readonly nativeLogins: SessionRegistry['sessionStore']['nativeLogins']
  readonly machines: SessionRegistry['sessionStore']['machines']
  readonly machineService: RegistryModules['machines']
  readonly settings: RegistryModules['settings']
  readonly nativeLogin: RegistryModules['nativeLogin']
  /** Copies a just-ticked login to the caller's machines (POD-6301). Optional
   *  so existing test states stay valid; absent, a tick copies on next use. */
  readonly loginPropagation?: Pick<RegistryModules['loginPropagation'], 'propagate'> | undefined
  readonly callerUserId: UserId
  /** The caller's standing on each machine it may run on: `custody` (its own)
   *  or `use` (someone else's it was given use of). See `PrivateResourceAccess`. */
  readonly machineStanding: () => Promise<ReadonlyMap<MachineId, 'custody' | 'use'>>
  readonly now?: (() => Date) | undefined
  /**
   * The viewer's usable server-AI login (POD-4750): which native login the
   * server-side LLM would spend for the CALLER's background role, and on which
   * machine — resolved once per list call. Implemented by the service closure,
   * which is the only side holding the users store for the scoped picker. The
   * harness returns as a value and rows match it by equality — never a
   * literal — so this stays correct for any future native-backed API role, not
   * just today's. Undefined when the role runs on no native login (or none is
   * usable for the viewer): rows then omit "Server AI uses …" rather than
   * inventing one. Optional so existing test states stay valid.
   *
   * `lastError` is the background role's last refusal text (POD-4805), when
   * the issue assistant has recorded one. It rides even when no machine could
   * be picked (machine fields then absent), so a refused server-AI call still
   * says why on Settings instead of looking fine.
   */
  readonly resolveCodexServerAi?:
    | (() => Promise<
        | {
            harness: HarnessAgent
            machineId?: MachineId
            machineName?: string
            lastError?: string
          }
        | undefined
      >)
    | undefined
}

export type AccountHandler<In, Out> = (state: AccountState, input: In) => Out

/**
 * THE TARGET CHECK FOR A USER'S OWN HARNESS ACCOUNTS (POD-6360). Every user
 * manages their own accounts, and only their own: each handler acts for the
 * signed-in caller (the login terminal is spawned as them, on a machine they may
 * use; a tick is theirs), so the target is the caller
 * by construction. What is left to refuse is a principal that is not that user:
 * an agent may not sign its human in or tick a login for them.
 * Agents and the system principal are refused; a signed-in user passes.
 */
export const callersOwnAccount: PlainTargetCheck = (principal) => principal.kind === 'user'

export interface AccountCommand {
  readonly contract: AnyCommandContract
  readonly targetPermitted?: PlainTargetCheck
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: AccountHandler<any, unknown>
}

export const ACCOUNT_COMMANDS_TRPC = {
  login: {
    contract: ACCOUNT_CONTRACTS.login,
    targetPermitted: callersOwnAccount,
    handler: ((state, input) =>
      state.nativeLogin.start({
        harness: input.harness,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        ownerUserId: asUserId(state.callerUserId),
      })) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['login']['input']>, unknown>,
  },
  useOnMyMachines: {
    contract: ACCOUNT_CONTRACTS.useOnMyMachines,
    targetPermitted: callersOwnAccount,
    handler: (async (state, input) => {
      const owner = asUserId(state.callerUserId)
      const custody = [...(await state.machineStanding())]
        .filter(([, standing]) => standing === 'custody')
        .map(([id]) => id)
      if (input.enabled) {
        // Only a login observed on one of the caller's own machines can be
        // ticked: it is theirs (design §2.5), and nobody else's is nameable.
        const observed = [...(await state.machines.getMachines(custody)).values()].some(
          (machine) =>
            !machine.revokedAt &&
            machine.inventory?.agents.some(
              (agent) =>
                agent.kind === input.harness &&
                agent.login.state === 'in' &&
                agent.login.identity?.fingerprint === input.fingerprint,
            ),
        )
        if (!observed) {
          throw new Error(`none of your machines is signed in to that ${input.harness} account`)
        }
      }
      await state.nativeLogins.setOptIn(
        owner,
        input.harness,
        input.fingerprint,
        input.enabled,
        (state.now?.() ?? new Date()).toISOString(),
      )
      // A tick reaches the caller's current machines now; future ones get it
      // when they enroll or first run that harness. Unticking copies nothing
      // more and recalls nothing already installed.
      if (input.enabled) {
        const refused: string[] = []
        for (const machineId of custody) {
          const result = await state.loginPropagation?.propagate({
            targetMachineId: machineId,
            agentKind: input.harness,
            principalUserId: owner,
            fingerprint: input.fingerprint,
            // A machine that has not reported this harness yet still gets it;
            // the daemon keeps any login already there.
            force: true,
          })
          if (result?.status === 'failed') refused.push(result.reason)
        }
        if (refused.length > 0)
          throw new Error(
            `The connection is enabled, but copying was refused: ${refused.join('; ')}`,
          )
      }
      return { ok: true as const, enabled: input.enabled }
    }) satisfies AccountHandler<
      z.infer<(typeof ACCOUNT_CONTRACTS)['useOnMyMachines']['input']>,
      unknown
    >,
  },
} as const satisfies Record<AccountContractName, AccountCommand>

export type AccountCommandName = keyof typeof ACCOUNT_COMMANDS_TRPC

export const isAccountCommand = (name: string): name is AccountCommandName =>
  Object.hasOwn(ACCOUNT_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isAccountCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isAccountCommand(name)) return false
  return ACCOUNT_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const accountCommandsOn = (transport: TransportTag): AccountCommandName[] =>
  ACCOUNT_CONTRACT_NAMES.filter((n) => isAccountCommandExposedOn(n, transport))

export const accountRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(ACCOUNT_COMMANDS_TRPC).map((c) => c.contract))
