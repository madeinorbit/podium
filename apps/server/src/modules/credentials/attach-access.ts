/**
 * THE STEP THAT SENDS A SECRET TO A DAEMON (credential management §8, "What
 * crosses the wire"; epic plan Task 5).
 *
 * The resolver's plan never holds a secret. This turns it into the `access`
 * field of the frame that starts a process, for the daemon that is connected
 * for the machine NOW, or refuses. For a vault credential the order is fixed
 * and every check runs before the vault is read:
 *
 *  - no daemon connected: `machine-offline` (a secret is never queued for a
 *    socket that does not exist yet);
 *  - the daemon did not offer `CAP_SESSION_ACCESS`: `daemon-too-old` (an
 *    older daemon would drop the field and start the harness on the
 *    machine's own login);
 *  - the server judged the connection `plain`: `connection-not-encrypted`.
 *
 * A home other than `default` needs the capability and reads no secret. No
 * credential returns no field, so a launch on the harness's own login is
 * unchanged on any daemon and any connection. Each refusal records a `refuse`
 * event and each delivery a `deliver` event; neither ever holds the secret.
 */

import type { CredentialId, MachineId, SessionId, UserId } from '@podium/model'
import { type AccessField, CAP_SESSION_ACCESS } from '@podium/protocol'
import type { DaemonLinkKind } from '../../gateway/daemon-link-kind'
import type { SessionStore } from '../../store'
import { type AccessRefusal, type AccessRefused, refuse, type SessionAccess } from './access'
import { recordCredentialEvent } from './events'
import { SecretUnavailableError, withSecret } from './vault'

export interface AttachAccessDeps {
  store: Pick<SessionStore, 'credentials' | 'vault' | 'settingsAudit'>
  /** Did the daemon connected for this machine negotiate `cap`? */
  daemonSupports(machineId: MachineId, cap: string): boolean
  /** The server's own judgement of that daemon's connection; undefined: none. */
  daemonLinkKind(machineId: MachineId): DaemonLinkKind | undefined
}

export interface AttachTarget {
  machineId: MachineId
  /** Named on the trail when the session already has an id. */
  sessionId?: SessionId
  /** The person the session runs for. */
  actingUserId: UserId
}

export type AttachedAccess = { ok: true; access?: AccessField } | AccessRefused

/** Why the vault could not hand over a secret, as the refusal a person reads. */
const SECRET_REFUSAL: Record<SecretUnavailableError['reason'], AccessRefusal> = {
  'not-found': 'not-found',
  revoked: 'revoked',
  'no-secret': 'needs-attention',
  'needs-attention': 'needs-attention',
}

/** The harness's own directory: no credential needs to be sent for it. */
const DEFAULT_HOME = 'default'

export async function attachAccess(
  deps: AttachAccessDeps,
  plan: SessionAccess,
  to: AttachTarget,
): Promise<AttachedAccess> {
  if (!plan.ok) return plan
  const credentialId = plan.credentialId
  if (credentialId === null) return { ok: true }
  const { delivery } = plan
  const capable = deps.daemonSupports(to.machineId, CAP_SESSION_ACCESS)
  const context = {
    credentialId,
    actingUserId: to.actingUserId,
    machineId: to.machineId,
    ...(to.sessionId ? { sessionId: to.sessionId } : {}),
  }
  if (delivery.kind === 'home') {
    if (delivery.homeId === DEFAULT_HOME && !capable) return { ok: true }
    if (!capable) return await refuse(deps.store, refusalForMissingCap(deps, to), context)
    await delivered(deps, credentialId, to, 'home')
    return { ok: true, access: { credentialId, delivery } }
  }
  if (!capable) return await refuse(deps.store, refusalForMissingCap(deps, to), context)
  if (deps.daemonLinkKind(to.machineId) === 'plain') {
    return await refuse(deps.store, 'connection-not-encrypted', context)
  }
  let secret: string
  try {
    secret = await withSecret(deps.store, credentialId, async (opened) => opened)
  } catch (error) {
    if (!(error instanceof SecretUnavailableError)) throw error
    return await refuse(deps.store, SECRET_REFUSAL[error.reason], context)
  }
  await delivered(deps, credentialId, to, 'env')
  return {
    ok: true,
    access: { credentialId, delivery: { kind: 'env', variable: delivery.variable, secret } },
  }
}

/** No capability: either no daemon is there at all, or it is an older one. */
function refusalForMissingCap(deps: AttachAccessDeps, to: AttachTarget): AccessRefusal {
  return deps.daemonLinkKind(to.machineId) === undefined ? 'machine-offline' : 'daemon-too-old'
}

async function delivered(
  deps: AttachAccessDeps,
  credentialId: CredentialId,
  to: AttachTarget,
  how: 'env' | 'home',
): Promise<void> {
  await recordCredentialEvent(deps.store, {
    kind: 'deliver',
    credentialId,
    actorUserId: to.actingUserId,
    machineId: to.machineId,
    ...(to.sessionId ? { sessionId: to.sessionId } : {}),
    detail: how,
  })
}
