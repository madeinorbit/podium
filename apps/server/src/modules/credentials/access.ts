/**
 * THE RESOLVER (credential management spec §3 R1, §8, §9).
 *
 * One place decides whether a session or a direct model call may use a
 * credential, and how it is handed over. The answer is a plan or a refusal
 * from a closed list; it never contains a secret. A refusal is final for that
 * launch: nothing falls back to another login.
 *
 * "Custody" is the machine grant with verb `manage` and custody set
 * (`MachinesRepository.custodian`). Admin rights over a machine are not custody.
 */

import { harnessAccepts } from '@podium/harness/metadata'
import {
  type AgentKind,
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialTypeId,
  INFERENCE_ROUTES,
  type InferenceRoute,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { SessionStore } from '../../store'
import type { CredentialRecord } from '../../store/credentials'
import { recordCredentialEvent } from './events'
import { type MayUseDeps, mayUse } from './may-use'

export type AccessRefusal =
  | 'not-found'
  | 'not-yours'
  | 'wrong-type'
  | 'not-on-this-machine'
  | 'machine-not-allowed'
  | 'own-credential-required'
  | 'needs-attention'
  | 'revoked'
  | 'daemon-too-old'
  | 'connection-not-encrypted'
  | 'machine-offline'

/** The one sentence a person reads for each refusal. */
export const ACCESS_REFUSAL_MESSAGES: Record<AccessRefusal, string> = {
  'not-found': 'This credential no longer exists.',
  'not-yours': 'You do not have use of this credential. Ask its owner to share it.',
  'wrong-type': 'This kind of credential cannot be used here.',
  'not-on-this-machine':
    'This login is not signed in on this machine. Sign in there, or pick another machine.',
  'machine-not-allowed': "This credential's owner has not sent it to this machine.",
  'own-credential-required':
    'The logins on this machine belong to the person who looks after it. Pick one of your own credentials.',
  'needs-attention':
    'This credential needs attention before it can be used. Renew it or pick another.',
  revoked: 'This credential was removed.',
  'daemon-too-old': 'Podium on this machine is too old to receive credentials. Update it.',
  'connection-not-encrypted':
    "This machine's connection to the server is not encrypted, so credentials are not sent to it. Connect it over wss or declare its network trusted.",
  'machine-offline':
    'This machine is not connected, so its credential cannot be sent. Try again when it is online.',
}

export type AccessRefused = { ok: false; refusal: AccessRefusal; message: string }

export type SessionDelivery = { kind: 'env'; variable: string } | { kind: 'home'; homeId: string }

export type SessionAccess =
  | { ok: true; credentialId: CredentialId | null; delivery: SessionDelivery }
  | AccessRefused

export type InferenceAccess =
  | { ok: true; credentialId: CredentialId; route: InferenceRoute; machineId?: MachineId }
  | AccessRefused

/** What the resolver reads and writes. A SessionStore satisfies it. */
export type AccessDeps = MayUseDeps &
  Pick<SessionStore, 'credentials' | 'machines' | 'settingsAudit'>

export interface SessionAccessInput {
  harness: AgentKind
  /** The driver the session runs on, when one was chosen. */
  driverId?: string
  /** `null`: no credential, the harness's own login in its default home. */
  credentialId: CredentialId | null
  /** The person the session runs for. */
  actingUserId: UserId
  machineId: MachineId
  /** Named on the refusal event when the session already has an id. */
  sessionId?: SessionId
}

/** The harness's own directory: the home Podium did not create. */
export const DEFAULT_HOME_ID = 'default'

export const refusal = (reason: AccessRefusal): AccessRefused => ({
  ok: false,
  refusal: reason,
  message: ACCESS_REFUSAL_MESSAGES[reason],
})

/** Record a refusal on the security trail and return it. */
export async function refuse(
  deps: Pick<SessionStore, 'settingsAudit'>,
  reason: AccessRefusal,
  context: {
    credentialId: CredentialId | null
    actingUserId: UserId
    machineId?: MachineId
    sessionId?: SessionId
  },
): Promise<AccessRefused> {
  await recordCredentialEvent(deps, {
    kind: 'refuse',
    credentialId: context.credentialId,
    actorUserId: context.actingUserId,
    ...(context.machineId ? { machineId: context.machineId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    detail: reason,
  })
  return refusal(reason)
}

const storedIn = (type: string): 'vault' | 'home' | undefined =>
  CREDENTIAL_TYPES[type as CredentialTypeId]?.store

/** The line of the harness's declaration that takes this type on this driver. */
function acceptedLine(harness: AgentKind, driverId: string | undefined, type: string) {
  return harnessAccepts(harness).find(
    (line) =>
      line.type === type &&
      (line.drivers === undefined || (driverId !== undefined && line.drivers.includes(driverId))),
  )
}

/**
 * The home on the machine whose login is this credential's account, as the
 * machine's inventory reports it (§10): the harness's own directory first,
 * then a home Podium made. Undefined when no home there is signed in to it.
 */
async function homeOnMachine(
  deps: Pick<SessionStore, 'machines'>,
  machineId: MachineId,
  harness: AgentKind,
  credential: CredentialRecord,
): Promise<string | undefined> {
  const fingerprint = credential.identity.fingerprint
  if (!fingerprint) return undefined
  const agent = (await deps.machines.getMachine(machineId))?.inventory?.agents.find(
    (a) => a.kind === harness,
  )
  if (!agent) return undefined
  if (agent.login.state === 'in' && agent.login.identity?.fingerprint === fingerprint) {
    return DEFAULT_HOME_ID
  }
  return agent.logins?.find(
    (login) =>
      login.homeId !== DEFAULT_HOME_ID &&
      login.state === 'in' &&
      login.identity?.fingerprint === fingerprint,
  )?.homeId
}

/** Exists, not removed, and the acting person may use it. */
async function usableBy(
  deps: AccessDeps,
  credentialId: CredentialId,
  actingUserId: UserId,
): Promise<{ ok: true; credential: CredentialRecord } | { ok: false; refusal: AccessRefusal }> {
  const credential = await deps.credentials.get(credentialId)
  if (!credential) return { ok: false, refusal: 'not-found' }
  if (credential.status === 'revoked') return { ok: false, refusal: 'revoked' }
  if ((await mayUse(deps, actingUserId, credential)) === null) {
    return { ok: false, refusal: 'not-yours' }
  }
  return { ok: true, credential }
}

/**
 * Which credential a session runs on and how it is handed over, or why not.
 * Checks, stopping at the first failure: with no credential, the acting
 * person holds custody of the machine, and that is the whole check; otherwise
 * the credential exists, is not removed, the person may use it, the harness
 * and driver accept its type, a login is signed in on the machine, its owner
 * holds custody of the machine or sent it there, and it is healthy.
 */
export async function resolveSessionAccess(
  deps: AccessDeps,
  i: SessionAccessInput,
): Promise<SessionAccess> {
  const context = {
    credentialId: i.credentialId,
    actingUserId: i.actingUserId,
    machineId: i.machineId,
    ...(i.sessionId ? { sessionId: i.sessionId } : {}),
  }
  if (i.credentialId === null) {
    if ((await deps.machines.custodian(i.machineId)) !== i.actingUserId) {
      return await refuse(deps, 'own-credential-required', context)
    }
    return { ok: true, credentialId: null, delivery: { kind: 'home', homeId: DEFAULT_HOME_ID } }
  }
  const usable = await usableBy(deps, i.credentialId, i.actingUserId)
  if (!usable.ok) return await refuse(deps, usable.refusal, context)
  const { credential } = usable
  const line = acceptedLine(i.harness, i.driverId, credential.type)
  if (!line) return await refuse(deps, 'wrong-type', context)
  const homeId =
    storedIn(credential.type) === 'home'
      ? await homeOnMachine(deps, i.machineId, i.harness, credential)
      : undefined
  if (storedIn(credential.type) === 'home' && !homeId) {
    return await refuse(deps, 'not-on-this-machine', context)
  }
  if (
    (await deps.machines.custodian(i.machineId)) !== credential.ownerUserId &&
    !(await deps.credentials.isMachineAllowed(credential.id, i.machineId))
  ) {
    return await refuse(deps, 'machine-not-allowed', context)
  }
  if (credential.status !== 'ok') return await refuse(deps, 'needs-attention', context)
  return {
    ok: true,
    credentialId: credential.id,
    delivery:
      line.deliver.kind === 'env'
        ? { kind: 'env', variable: line.deliver.variable }
        : { kind: 'home', homeId: homeId ?? DEFAULT_HOME_ID },
  }
}

/**
 * How a direct model call is served for a credential, or why not. A call made
 * on the server discloses nothing to any machine, so no machine rule applies
 * here; an `on-machine` route names its machine once Task 12 places it.
 */
export async function resolveInferenceAccess(
  deps: AccessDeps,
  i: { credentialId: CredentialId; actingUserId: UserId },
): Promise<InferenceAccess> {
  const context = { credentialId: i.credentialId, actingUserId: i.actingUserId }
  const usable = await usableBy(deps, i.credentialId, i.actingUserId)
  if (!usable.ok) return await refuse(deps, usable.refusal, context)
  const route = INFERENCE_ROUTES[usable.credential.type as CredentialTypeId]
  if (!route) return await refuse(deps, 'wrong-type', context)
  if (usable.credential.status !== 'ok') return await refuse(deps, 'needs-attention', context)
  return { ok: true, credentialId: usable.credential.id, route }
}
