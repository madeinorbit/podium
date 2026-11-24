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
  ACCESS_REFUSAL_MESSAGES,
  type AccessRefusal,
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

// The closed list and its sentences live in @podium/model, so a client reads a
// refusal by its code (credential management §9).
export { ACCESS_REFUSAL_MESSAGES, type AccessRefusal } from '@podium/model'

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

/**
 * THE REFUSALS THAT WITHDRAW A RUNNING SESSION'S RIGHT TO ITS CREDENTIAL
 * (POD-7591). Judged again for a process that already holds the secret (a
 * refresh, or a grant that ended), one of these stops it: at once when the
 * credential is gone or its grant was taken back ({@link STOPS_AT_ONCE}), at its
 * next turn boundary when its machine was withdrawn or the session may not run
 * on it. The others are delivery conditions, not withdrawals, and leave the
 * running process alone: `needs-attention` (renewal restarts the session),
 * `not-on-this-machine` (read from the machine's reported logins, which a late or
 * expired report changes, for a home login Podium put no secret into: review
 * F4), `daemon-too-old`, `connection-not-encrypted` and `machine-offline`.
 */
export const WITHDRAWS_ACCESS: ReadonlySet<AccessRefusal> = new Set<AccessRefusal>([
  'not-found',
  'revoked',
  'not-yours',
  'machine-not-allowed',
  'wrong-type',
  'own-credential-required',
])

/**
 * The withdrawals that stop a running session AT ONCE, cutting its turn
 * (POD-7591, coordinator decision): the credential is gone or someone took the
 * grant back on purpose, and a turn can run for an hour. The transcript and the
 * worktree survive; only the turn in flight is lost. The other withdrawals (the
 * machine taken back, a type or custody rule) stop it at its next turn boundary.
 */
export const STOPS_AT_ONCE: ReadonlySet<AccessRefusal> = new Set<AccessRefusal>([
  'revoked',
  'not-found',
  'not-yours',
])

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
