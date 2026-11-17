/**
 * THE CREDENTIAL COMMANDS (credential management §6, §8, §12; epic Task 4).
 *
 * A person adds their own keys and tokens, and the owner or a holder of `manage`
 * renames, renews, removes and shares them, and allows them on machines the owner
 * does not look after. Every command is a person's: the target check refuses an
 * agent session, whoever it acts for. A credential the caller may not use answers
 * as one that does not exist; one the caller may only use answers that they may
 * not change it. Being an admin counts for nothing here.
 *
 * The secret goes into the vault and nowhere else: results return ids, events
 * name the credential, and identity holds a fingerprint and a mask.
 */

import {
  type AnyCommandContract,
  CREDENTIAL_CONTRACT_NAMES,
  CREDENTIAL_CONTRACTS,
  CREDENTIAL_MACHINE_DISCLOSURE,
  CREDENTIAL_SHARE_DISCLOSURE,
  CREDENTIAL_SHARE_WARNING,
  type CredentialContractName,
  type CredentialGrantee,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import {
  ALL_MEMBERS_GRANTEE,
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialTypeId,
  isCredentialTypeId,
  type MachineId,
  type UserId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import type { SessionStore } from '../../store'
import { type CredentialRecord, newCredentialId } from '../../store/credentials'
import type { PlainTargetCheck } from '../plain-command/entry'
import { SignInRefused } from './chatgpt-plan/authorize'
import { type ChatgptPlanService, LoopbackUnavailable } from './chatgpt-plan/service'
import { type CredentialEvent, recordCredentialEvent } from './events'
import { pastedIdentity } from './fingerprint'
import { type NativeLoginState, useOnMyMachines } from './native-login-actions'
import type { CodexServerAiMarker } from './server-ai-status'
import type { CredentialHealth } from './health'
import { CREDENTIAL_RESOURCE_KIND, type CredentialAccessLevel, mayUse } from './may-use'
import { SignInRefused as HomeSignInRefused, type HomeSignInService } from './sign-in'
import { sealCredentialSecret, VaultLockedError } from './vault'

/** The store tables the credential family reaches. A SessionStore satisfies it. */
export type CredentialsStore = Pick<
  SessionStore,
  'credentials' | 'vault' | 'grants' | 'users' | 'machines' | 'settingsAudit' | 'secrets'
>

/** Exactly what the credential family reaches, named. */
export interface CredentialsState {
  readonly store: CredentialsStore
  readonly callerUserId: UserId
  /** Verification, renewal follow-up, removal everywhere and share notices (Task 13). */
  readonly health: CredentialHealth
  /** Sign in with ChatGPT and its keeper (Task 14). Absent: not offered here. */
  readonly chatgpt?: ChatgptPlanService
  /** Signing in to a subscription on a machine (Task 9). Absent: not offered here. */
  readonly signIn?: HomeSignInService
  readonly native?: NativeLoginState
  readonly resolveServerAi?: () => Promise<CodexServerAiMarker | undefined>
}

export type CredentialHandler<In, Out> = (state: CredentialsState, input: In) => Out

export interface CredentialCommand {
  readonly contract: AnyCommandContract
  readonly targetPermitted?: PlainTargetCheck
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: CredentialHandler<any, unknown>
}

/** Only a person, never an agent session acting for one. */
export const personOnly: PlainTargetCheck = (principal) => principal.kind === 'user'

export const USE_ONLY_MESSAGE = 'You may use this credential but not change it.'

const notFound = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'no such credential' })
const badRequest = (message: string): TRPCError => new TRPCError({ code: 'BAD_REQUEST', message })

/** The credential the input names, if the caller may change it. */
async function writable(
  state: CredentialsState,
  credentialId: CredentialId,
): Promise<{ record: CredentialRecord; access: CredentialAccessLevel }> {
  const record = await state.store.credentials.get(credentialId)
  if (!record || record.status === 'revoked') throw notFound()
  const access = await mayUse(state.store, state.callerUserId, record)
  if (access === null) throw notFound()
  if (access === 'use') throw new TRPCError({ code: 'FORBIDDEN', message: USE_ONLY_MESSAGE })
  return { record, access }
}

/** Types a person adds by pasting a secret Podium stores. */
function pasted(type: string): type is CredentialTypeId {
  if (!isCredentialTypeId(type)) return false
  const spec = CREDENTIAL_TYPES[type]
  return spec.store === 'vault' && spec.obtain.includes('paste')
}

/** The ChatGPT module, or a refusal when this server was built without it. */
function chatgptOf(state: CredentialsState): ChatgptPlanService {
  if (!state.chatgpt) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Sign in with ChatGPT is not available on this server.',
    })
  }
  return state.chatgpt
}

const signInRefusal = (error: unknown): never => {
  if (error instanceof SignInRefused || error instanceof LoopbackUnavailable) {
    throw badRequest(error.message)
  }
  throw error
}

/** The machine sign-in module, or a refusal when this server was built without it. */
function signInOf(state: CredentialsState): HomeSignInService {
  if (!state.signIn) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Signing in on a machine is not available on this server.',
    })
  }
  return state.signIn
}

const homeSignInRefusal = (error: unknown): never => {
  if (error instanceof HomeSignInRefused) {
    if (error.code === 'not-found')
      throw new TRPCError({ code: 'NOT_FOUND', message: error.message })
    throw new TRPCError({
      code: error.refusal === 'machine-not-allowed' ? 'FORBIDDEN' : 'BAD_REQUEST',
      message: error.message,
      ...(error.refusal ? { cause: error } : {}),
    })
  }
  throw error
}

const notPasted = (type: string): TRPCError =>
  badRequest(
    `${isCredentialTypeId(type) ? CREDENTIAL_TYPES[type].title : type} is not added or renewed by pasting it.`,
  )

const vaultRefusal = (error: unknown): never => {
  if (error instanceof VaultLockedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message })
  }
  throw error
}

async function event(
  state: CredentialsState,
  i: Omit<CredentialEvent, 'actorUserId'>,
): Promise<void> {
  await recordCredentialEvent(state.store, { ...i, actorUserId: state.callerUserId })
}

/** The `grants.grantee` value for a share input, after the checks a share needs. */
async function granteeColumn(
  state: CredentialsState,
  record: CredentialRecord,
  grantee: CredentialGrantee,
): Promise<string> {
  if (grantee === 'all-members') return ALL_MEMBERS_GRANTEE
  if (grantee.userId === record.ownerUserId) {
    throw badRequest('This credential belongs to that person already.')
  }
  if (!(await state.store.users.get(grantee.userId))) {
    throw badRequest('There is no such member.')
  }
  return grantee.userId
}

const describeGrantee = (grantee: CredentialGrantee): string =>
  grantee === 'all-members' ? ALL_MEMBERS_GRANTEE : grantee.userId

type In<N extends CredentialContractName> = z.infer<(typeof CREDENTIAL_CONTRACTS)[N]['input']>

export const CREDENTIAL_COMMANDS_TRPC = {
  login: {
    contract: CREDENTIAL_CONTRACTS.login,
    targetPermitted: personOnly,
    handler: ((state, input) => {
      if (!state.native) throw badRequest('Machine login is not available on this server.')
      return state.native.nativeLogin.start({ ...input, ownerUserId: state.callerUserId })
    }) satisfies CredentialHandler<In<'login'>, unknown>,
  },
  useOnMyMachines: {
    contract: CREDENTIAL_CONTRACTS.useOnMyMachines,
    targetPermitted: personOnly,
    handler: ((state, input) => {
      if (!state.native) throw badRequest('Machine login is not available on this server.')
      return useOnMyMachines(state.native, state.callerUserId, input)
    }) satisfies CredentialHandler<In<'useOnMyMachines'>, unknown>,
  },
  add: {
    contract: CREDENTIAL_CONTRACTS.add,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      if (!pasted(input.type)) throw notPasted(input.type)
      const owner = state.callerUserId
      const identity = pastedIdentity(
        input.type,
        input.secret,
        await state.store.secrets.fingerprintKey(),
      )
      const same = await state.store.credentials.findByIdentity({
        ownerUserId: owner,
        type: input.type,
        fingerprint: identity.fingerprint,
      })
      if (same) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `You already added this key as "${same.label}".`,
        })
      }
      const verified = await state.health.verify(input.type, input.secret)
      if (!verified.ok) throw badRequest(verified.reason)
      const id = newCredentialId()
      const sealed = await state.store.vault
        .seal({ credentialId: id, type: input.type, version: 1 }, Buffer.from(input.secret, 'utf8'))
        .catch(vaultRefusal)
      await state.store.credentials.insertWithSecret(
        {
          id,
          ownerUserId: owner,
          label: input.label,
          type: input.type,
          identity,
          ...(verified.expiresAt ? { expiresAt: verified.expiresAt } : {}),
        },
        sealed,
      )
      if (verified.providerChecked) await state.health.markVerified(id)
      await event(state, { kind: 'add', credentialId: id, detail: input.type })
      return { credentialId: id }
    }) satisfies CredentialHandler<In<'add'>, unknown>,
  },
  rename: {
    contract: CREDENTIAL_CONTRACTS.rename,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      await state.store.credentials.rename(record.id, input.label)
      await event(state, { kind: 'rename', credentialId: record.id })
      return { ok: true as const }
    }) satisfies CredentialHandler<In<'rename'>, unknown>,
  },
  renew: {
    contract: CREDENTIAL_CONTRACTS.renew,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      if (!pasted(record.type)) throw notPasted(record.type)
      const verified = await state.health.verify(record.type, input.secret)
      if (!verified.ok) throw badRequest(verified.reason)
      const identity = pastedIdentity(
        record.type,
        input.secret,
        await state.store.secrets.fingerprintKey(),
      )
      const latest = await state.store.credentials.latestSecret(record.id)
      const stored = await sealCredentialSecret(
        state.store,
        record,
        input.secret,
        latest?.version ?? 0,
      ).catch(vaultRefusal)
      if (stored === 'conflict') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This credential was renewed at the same moment. Look at it again, then renew.',
        })
      }
      await state.store.credentials.setIdentity(record.id, { ...record.identity, ...identity })
      if (verified.expiresAt)
        await state.store.credentials.setExpiresAt(record.id, verified.expiresAt)
      if (record.status !== 'ok') await state.store.credentials.setStatus(record.id, 'ok')
      await event(state, { kind: 'renew', credentialId: record.id, detail: `version ${stored}` })
      await state.health.afterRenew(record, verified)
      return { ok: true as const }
    }) satisfies CredentialHandler<In<'renew'>, unknown>,
  },
  remove: {
    contract: CREDENTIAL_CONTRACTS.remove,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      // A grant at the provider ends there first (§11: OpenAI's revocation);
      // removal goes on whatever it answers, and the person is told.
      const providerCall =
        isCredentialTypeId(record.type) &&
        CREDENTIAL_TYPES[record.type].revocation === 'provider-call' &&
        state.chatgpt
          ? await state.chatgpt.keeper.revoke(record.id)
          : undefined
      await state.health.removeEverywhere(record.id, state.callerUserId)
      return {
        ok: true as const,
        ...(providerCall ? { providerRevocation: providerCall } : {}),
      }
    }) satisfies CredentialHandler<In<'remove'>, unknown>,
  },
  chatgptSignInStart: {
    contract: CREDENTIAL_CONTRACTS.chatgptSignInStart,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const chatgpt = chatgptOf(state)
      if (input.credentialId) {
        const record = await state.store.credentials.get(input.credentialId)
        // Signing in again replaces the account's tokens: the owner's own act.
        if (!record || record.status === 'revoked' || record.ownerUserId !== state.callerUserId) {
          throw notFound()
        }
      }
      if (input.machineId) {
        const machine = await state.store.machines.getMachine(input.machineId)
        if (
          !machine ||
          machine.revokedAt ||
          (await state.store.machines.custodian(input.machineId)) !== state.callerUserId
        ) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown machine' })
        }
      }
      return await chatgpt
        .start({
          ownerUserId: state.callerUserId,
          ...(input.label ? { label: input.label } : {}),
          ...(input.machineId ? { machineId: input.machineId as MachineId } : {}),
          ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        })
        .catch(signInRefusal)
    }) satisfies CredentialHandler<In<'chatgptSignInStart'>, unknown>,
  },
  chatgptSignInComplete: {
    contract: CREDENTIAL_CONTRACTS.chatgptSignInComplete,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      return await chatgptOf(state)
        .completePasted({
          attemptId: input.attemptId,
          pastedUrl: input.pastedUrl,
          actorUserId: state.callerUserId,
        })
        .catch(signInRefusal)
    }) satisfies CredentialHandler<In<'chatgptSignInComplete'>, unknown>,
  },
  signInStart: {
    contract: CREDENTIAL_CONTRACTS.signInStart,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      return await signInOf(state)
        .start({
          ownerUserId: state.callerUserId,
          type: input.type,
          machineId: input.machineId as MachineId,
          ...(input.label ? { label: input.label } : {}),
          ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        })
        .catch(homeSignInRefusal)
    }) satisfies CredentialHandler<In<'signInStart'>, unknown>,
  },
  signInCancel: {
    contract: CREDENTIAL_CONTRACTS.signInCancel,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      await signInOf(state).cancel(input.credentialId, state.callerUserId).catch(homeSignInRefusal)
      return { ok: true as const }
    }) satisfies CredentialHandler<In<'signInCancel'>, unknown>,
  },
  share: {
    contract: CREDENTIAL_CONTRACTS.share,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      if (input.acknowledgeDisclosure !== true) {
        throw badRequest(
          `${CREDENTIAL_SHARE_DISCLOSURE} Share again with the disclosure acknowledged.`,
        )
      }
      const sharing = isCredentialTypeId(record.type)
        ? CREDENTIAL_TYPES[record.type].sharing
        : 'warn'
      if (sharing === 'warn' && input.acknowledgeWarning !== true) {
        throw badRequest(`${CREDENTIAL_SHARE_WARNING} Share again with the warning acknowledged.`)
      }
      if (input.grantee === 'all-members' && input.verb !== 'use') {
        throw badRequest('Only use can be given to all members; give manage to a person.')
      }
      const grantee = await granteeColumn(state, record, input.grantee)
      const caller = state.callerUserId
      await state.store.grants.upsert({
        resourceKind: CREDENTIAL_RESOURCE_KIND,
        resourceId: record.id,
        grantee,
        verb: input.verb,
        owner: caller,
        visibility: 'secret',
        createdAt: new Date().toISOString(),
        actorKind: 'user',
        actorId: caller,
        onBehalfOf: caller,
      })
      await event(state, {
        kind: 'share',
        credentialId: record.id,
        detail: `${input.verb} to ${grantee}`,
      })
      await state.health.afterShare(record, input.grantee, input.verb, caller)
      return { ok: true as const }
    }) satisfies CredentialHandler<In<'share'>, unknown>,
  },
  unshare: {
    contract: CREDENTIAL_CONTRACTS.unshare,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      const grantee = describeGrantee(input.grantee)
      let removed = false
      for (const verb of input.verb ? [input.verb] : (['use', 'manage'] as const)) {
        if (await state.store.grants.remove(CREDENTIAL_RESOURCE_KIND, record.id, grantee, verb)) {
          removed = true
        }
      }
      if (removed) {
        await event(state, {
          kind: 'unshare',
          credentialId: record.id,
          detail: `${input.verb ?? 'use and manage'} from ${grantee}`,
        })
      }
      return { ok: true as const, removed }
    }) satisfies CredentialHandler<In<'unshare'>, unknown>,
  },
  allowMachine: {
    contract: CREDENTIAL_CONTRACTS.allowMachine,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      if (input.acknowledgeDisclosure !== true) {
        throw badRequest(`${CREDENTIAL_MACHINE_DISCLOSURE} Allow again with this acknowledged.`)
      }
      const machine = await state.store.machines.getMachine(input.machineId)
      if (!machine || machine.revokedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown machine' })
      }
      await state.store.credentials.allowMachine(record.id, input.machineId, state.callerUserId)
      await event(state, {
        kind: 'share',
        credentialId: record.id,
        machineId: input.machineId as MachineId,
        detail: 'allowed on machine',
      })
      return { ok: true as const }
    }) satisfies CredentialHandler<In<'allowMachine'>, unknown>,
  },
  disallowMachine: {
    contract: CREDENTIAL_CONTRACTS.disallowMachine,
    targetPermitted: personOnly,
    handler: (async (state, input) => {
      const { record } = await writable(state, input.credentialId)
      await state.store.credentials.disallowMachine(record.id, input.machineId)
      await event(state, {
        kind: 'unshare',
        credentialId: record.id,
        machineId: input.machineId as MachineId,
        detail: 'no longer allowed on machine',
      })
      return { ok: true as const }
    }) satisfies CredentialHandler<In<'disallowMachine'>, unknown>,
  },
} as const satisfies Record<CredentialContractName, CredentialCommand>

export type CredentialCommandName = keyof typeof CREDENTIAL_COMMANDS_TRPC

export const isCredentialCommand = (name: string): name is CredentialCommandName =>
  Object.hasOwn(CREDENTIAL_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isCredentialCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isCredentialCommand(name)) return false
  return CREDENTIAL_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const credentialCommandsOn = (transport: TransportTag): CredentialCommandName[] =>
  CREDENTIAL_CONTRACT_NAMES.filter((n) => isCredentialCommandExposedOn(n, transport))

export const credentialRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(CREDENTIAL_COMMANDS_TRPC).map((c) => c.contract))
