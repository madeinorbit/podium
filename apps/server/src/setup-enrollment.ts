import { hostname } from 'node:os'
import { asMachineId, asUserId, type UserId } from '@podium/model'
import { parseWirePublicKey } from '@podium/runtime/signing'
import type { SetupEnrollmentRequest } from '@podium/runtime/setup-enrollment'
import type { SessionStore } from './store'

export interface SetupEnrollmentReceipt extends SetupEnrollmentRequest {
  installationId: string
  actor: UserId | null
}
const receiptKey = (installationId: string, request: SetupEnrollmentRequest) =>
  JSON.stringify([installationId, request.machineId, request.requestId])

export async function readSetupEnrollment(store: SessionStore, installationId: string, request: SetupEnrollmentRequest): Promise<SetupEnrollmentReceipt | undefined> {
  const raw = await store.settings.setupEnrollmentReceipt(receiptKey(installationId, request))
  return raw ? JSON.parse(raw) as SetupEnrollmentReceipt : undefined
}

/** The caller supplies an authenticated actor, or consumes an explicit first-boot setup act. */
export async function enrollSetupMachine(
  store: SessionStore, installationId: string, request: SetupEnrollmentRequest,
  actor: UserId | null,
): Promise<SetupEnrollmentReceipt> {
  if (!installationId || !parseWirePublicKey(request.publicKey)) throw new Error('invalid setup enrollment identity')
  return store.transact(async () => {
    const prior = await readSetupEnrollment(store, installationId, request)
    if (prior) {
      if (prior.publicKey !== request.publicKey || prior.agentExecution !== request.agentExecution
        || (actor !== null && prior.actor !== actor)) throw new Error('setup enrollment request was already committed with different values')
      return prior
    }
    if (actor !== null) {
      const member = await store.users.get(actor)
      if (!member || member.disabledAt || member.role !== 'admin') throw new Error('setup enrollment requires an active admin')
    }
    const id = asMachineId(request.machineId)
    const enrolled = await store.machines.enrollMachine({
      id, name: hostname(), hostname: hostname(), tokenHash: '', credentialKind: 'ed25519',
      publicKey: request.publicKey, ownerUserId: actor, podiumManaged: true,
      assignment: { server: true, agentExecution: request.agentExecution },
      assignmentEvidence: { version: 1, source: 'setup', requestId: request.requestId },
    })
    if (!enrolled) throw new Error('setup machine id is already enrolled')
    const receipt = { ...request, installationId, actor }
    await store.settings.recordSetupEnrollment(receiptKey(installationId, request), JSON.stringify(receipt))
    await store.settingsAudit.append({ command: 'machines.enrollSetup', outcome: 'applied',
      actorKind: actor ? 'user' : 'system', actorId: actor, onBehalfOf: actor,
      detail: { installationId, machineId: id, requestId: request.requestId, publicKey: request.publicKey },
      redactedPaths: [], createdAt: new Date().toISOString() })
    return receipt
  })
}

/** Bind once while consuming the explicit setup request, never infer an owner on later boots. */
export async function completePreauthorizedSetup(store: SessionStore, installationId: string, request: SetupEnrollmentRequest, passwordHash?: string): Promise<SetupEnrollmentReceipt | undefined> {
  return store.transact(async () => {
    const prior = await readSetupEnrollment(store, installationId, request)
    if (prior) return prior
    if (!request.preauthorized) return undefined
    const members = await store.users.loadWorldUsers()
    const sole = members.length === 1 ? members[0] : undefined
    const actor = sole && !sole.disabledAt && sole.role === 'admin' ? asUserId(sole.id) : null
    if (actor && passwordHash) {
      const credential = await store.users.credentialFor(actor)
      if (!credential?.passwordHash || credential.source !== 'per-user-scrypt') {
        await store.users.setPasswordHash(actor, passwordHash, new Date().toISOString())
      }
    }
    return enrollSetupMachine(store, installationId, request, actor)
  })
}

/**
 * Move an upgraded host's legacy row onto the key staged for it (POD-5931).
 *
 * The request was written by the one-shot import of a 0.1.0 host's state files, next to
 * the private key, in the server's own state dir, so it names this host and nothing else. The
 * row keeps its id, owner, repos and sessions; only the credential and the service
 * assignment (always server, plus agents when this host runs them) change. Like setup,
 * the receipt makes a retry after a lost parent confirmation return the same answer.
 * `undefined` when the row is not a legacy host row — the caller then has nothing to do.
 */
export async function adoptLegacyHostMachine(store: SessionStore, installationId: string,
  request: SetupEnrollmentRequest): Promise<SetupEnrollmentReceipt | undefined> {
  if (!installationId || !parseWirePublicKey(request.publicKey)) throw new Error('invalid setup enrollment identity')
  return store.transact(async () => {
    const prior = await readSetupEnrollment(store, installationId, request)
    if (prior) return prior
    const id = asMachineId(request.machineId)
    const adopted = await store.machines.adoptLegacyHostCredential(id, request.publicKey,
      { server: true, agentExecution: request.agentExecution },
      { version: 1, source: 'legacy-host-adoption', requestId: request.requestId })
    if (!adopted) return undefined
    const actor = await store.machines.custodian(id)
    const receipt = { ...request, installationId, actor: actor ? asUserId(actor) : null }
    await store.settings.recordSetupEnrollment(receiptKey(installationId, request), JSON.stringify(receipt))
    await store.settingsAudit.append({ command: 'machines.adoptLegacyHost', outcome: 'applied',
      actorKind: 'system', actorId: null, onBehalfOf: null,
      detail: { installationId, machineId: id, requestId: request.requestId, publicKey: request.publicKey },
      redactedPaths: [], createdAt: new Date().toISOString() })
    return receipt
  })
}
