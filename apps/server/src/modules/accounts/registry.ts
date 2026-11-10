/**
 * THE JOIN — the account contracts (L1) paired with the L3 code that
 * implements them, per ADR 3 D1.
 *
 * The handlers are the router procedure bodies, MOVED and not rewritten: the same
 * id derivation, the same `maskCredential` identity, the same `{ id }` return
 * that deliberately never echoes the credential.
 *
 * This family selects the accounts REPOSITORY and the settings service — the
 * repository because managed credentials are a store table with no service in
 * front of them, and settings because the `list` read merges native CLI logins
 * with what Podium stores.
 */

import {
  ACCOUNT_CONTRACT_NAMES,
  ACCOUNT_CONTRACTS,
  type AccountContractName,
  type AnyCommandContract,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import {
  asAccountId,
  asUserId,
  type HarnessAgent,
  type MachineId,
  SHARED_MACHINE_ACCOUNT_WARNING,
  type UserId,
  type UserRole,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import { maskCredential } from '../../accounts'
import type { RegistryModules, SessionRegistry } from '../../relay'
import { SHARED_WITH_EVERYONE } from '../../store/accounts'
import type { SettingsAuditRepository } from '../../store/settings-audit'
import type { PlainTargetCheck } from '../plain-command/entry'

/** Exactly what the account family reaches, named. */
export interface AccountState {
  readonly accounts: SessionRegistry['sessionStore']['accounts']
  readonly machines: SessionRegistry['sessionStore']['machines']
  readonly machineService: RegistryModules['machines']
  readonly settings: RegistryModules['settings']
  readonly nativeLogin: RegistryModules['nativeLogin']
  /** Copies a just-ticked login to the caller's machines (POD-6301). Optional
   *  so existing test states stay valid; absent, a tick copies on next use. */
  readonly loginPropagation?: Pick<RegistryModules['loginPropagation'], 'propagate'> | undefined
  readonly callerUserId: UserId
  /** The key directory is available only to an authenticated human admin. */
  readonly requireKeyAdmin: () => void
  /** The caller's role. An admin sees the instance's legacy provider keys
   *  (instance settings); it never sees anyone's connections. */
  readonly callerRole?: (() => Promise<UserRole | undefined>) | undefined
  /** The caller's standing on each machine it may run on: `custody` (its own)
   *  or `use` (someone else's it was given use of). See `PrivateResourceAccess`. */
  readonly machineStanding: () => Promise<ReadonlyMap<MachineId, 'custody' | 'use'>>
  readonly now?: (() => Date) | undefined
  /** The settings audit trail, where a taken-back send is recorded (POD-6699).
   *  Optional so existing test states stay valid; absent, nothing is recorded. */
  readonly audit?: Pick<SettingsAuditRepository, 'append'> | undefined
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
 * use; a key is stored, removed or shared as theirs), so the target is the caller
 * by construction. What is left to refuse is a principal that is not that user:
 * an agent may not sign its human in, store a key as them, remove or share one.
 * Agents and the system principal are refused; a signed-in user passes.
 */
export const callersOwnAccount: PlainTargetCheck = (principal) => principal.kind === 'user'

/**
 * `accounts.share` and `accounts.unsend`: the key's owner, or an admin. A signed-in user may change the
 * sharing of their own key; naming another owner needs the admin role.
 */
export const ownerOrAdmin: PlainTargetCheck = (principal, input) => {
  if (principal.kind !== 'user') return false
  const owner = (input as { owner?: UserId }).owner
  return owner === undefined || owner === principal.user || principal.capability.role === 'admin'
}

/** One answer for "no such key" and "not yours" (errorConsistency: nonexistent). */
const noSuchKey = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'no such stored key' })

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
  connect: {
    contract: ACCOUNT_CONTRACTS.connect,
    targetPermitted: callersOwnAccount,
    handler: (async (state, input) => {
      // A Claude setup-token is its own account, distinct from an Anthropic API
      // key. Derived server-side, which is what makes the contract's
      // `callerSuppliedTargetId: false` true rather than aspirational. The row
      // is the CALLER's (POD-6300): the same id is another member's own row.
      const id = input.kind === 'oauth' ? 'managed:claude-oauth' : `managed:${input.provider}`
      // The caller's own row: a reconnect replaces their key and keeps their
      // sharing; a first connect starts private.
      await state.accounts.connect({
        ownerUserId: asUserId(state.callerUserId),
        accountKey: asAccountId(id),
        provider: input.provider,
        kind: input.kind,
        credential: input.credential,
        identity: maskCredential(input.credential),
        scope: 'role',
        createdAt: Date.now(),
      })
      // Only the id: the credential must never be echoed back to a client.
      return { id }
    }) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['connect']['input']>, unknown>,
  },
  disconnect: {
    contract: ACCOUNT_CONTRACTS.disconnect,
    targetPermitted: callersOwnAccount,
    handler: (async (state, input) => {
      // Only the caller's own row. Another user's key, shared with the caller or
      // not, is untouched: idempotent revocation, as the contract states.
      await state.accounts.disconnect(asUserId(state.callerUserId), input.id)
      return { ok: true as const }
    }) satisfies AccountHandler<
      z.infer<(typeof ACCOUNT_CONTRACTS)['disconnect']['input']>,
      unknown
    >,
  },
  send: {
    contract: ACCOUNT_CONTRACTS.send,
    targetPermitted: callersOwnAccount,
    handler: (async (state, input) => {
      const owner = asUserId(state.callerUserId)
      if (!(await state.accounts.getFor(owner, input.id))) {
        throw new Error(`you have no connection ${input.id} to send`)
      }
      const standing = (await state.machineStanding()).get(input.machineId)
      if (standing === undefined) throw new Error(`unknown machine: ${input.machineId}`)
      if (standing === 'custody') {
        // The owner's own machine runs the owner's connections already.
        return { ok: true as const, sent: false as const }
      }
      if (input.acknowledgeSharedMachine !== true) {
        throw new Error(
          `${SHARED_MACHINE_ACCOUNT_WARNING} Send again with the warning acknowledged to continue.`,
        )
      }
      await state.accounts.markSent(
        owner,
        input.id,
        input.machineId,
        (state.now?.() ?? new Date()).toISOString(),
      )
      return { ok: true as const, sent: true as const, warning: SHARED_MACHINE_ACCOUNT_WARNING }
    }) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['send']['input']>, unknown>,
  },
  unsend: {
    contract: ACCOUNT_CONTRACTS.unsend,
    targetPermitted: ownerOrAdmin,
    handler: (async (state, input) => {
      const owner = input.owner ?? asUserId(state.callerUserId)
      if (!(await state.accounts.getFor(owner, input.id))) throw noSuchKey()
      const caller = asUserId(state.callerUserId)
      const removed = await state.accounts.unmarkSent(
        owner,
        input.id,
        input.machineId,
        async () => {
          // The target check admits only a signed-in user, so the actor and the
          // human it acts for are both the caller (an admin acting for the owner
          // is still the actor; the owner is in the detail).
          await state.audit?.append({
            command: 'accounts.unsend',
            outcome: 'applied',
            actorKind: 'user',
            actorId: caller,
            onBehalfOf: caller,
            detail: { id: input.id, owner, machineId: input.machineId },
            redactedPaths: [],
            createdAt: (state.now?.() ?? new Date()).toISOString(),
          })
        },
      )
      if (!removed) return { ok: true as const, removed: false as const }
      const machineName =
        (await state.machines.getMachine(input.machineId))?.name ?? input.machineId
      return {
        ok: true as const,
        removed: true as const,
        // Spawn reads the sends afresh (account-env.ts); what has already been
        // spawned holds the key in its environment.
        note:
          `The next run on "${machineName}" no longer gets this key. Sessions already running on ` +
          `"${machineName}" keep it until they restart.`,
      }
    }) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['unsend']['input']>, unknown>,
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
      await state.accounts.setOptIn(
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
  share: {
    contract: ACCOUNT_CONTRACTS.share,
    targetPermitted: ownerOrAdmin,
    handler: (async (state, input) => {
      const owner = input.owner ?? asUserId(state.callerUserId)
      // The owner always has their own key; naming them shares nothing more.
      const users = input.users.filter((user) => user !== owner)
      const sharedWith = input.everyone ? [SHARED_WITH_EVERYONE, ...users] : users
      if (!(await state.accounts.share(owner, input.id, sharedWith))) throw noSuchKey()
      return { ok: true as const }
    }) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['share']['input']>, unknown>,
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
