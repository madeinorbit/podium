/**
 * CREDENTIAL EVENTS — what happened to a credential, by whom, written to the
 * server's security trail (`settings_audit_events`, the one the admin audit reads).
 *
 * The input has no field that takes a secret, and the stored detail is built
 * field by field from the named inputs, never spread: a caller that smuggles an
 * extra property through a cast still stores only these fields.
 */

import type { CredentialId, MachineId, SessionId, UserId } from '@podium/model'
import type { SettingsAuditRepository } from '../../store/settings-audit'

export const CREDENTIAL_EVENT_KINDS = [
  'add',
  'rename',
  'renew',
  'remove',
  'share',
  'unshare',
  'deliver',
  'switch',
  'refuse',
  'attention',
] as const
export type CredentialEventKind = (typeof CREDENTIAL_EVENT_KINDS)[number]

export interface CredentialEvent {
  kind: CredentialEventKind
  credentialId: CredentialId | null
  actorUserId: UserId
  sessionId?: SessionId
  machineId?: MachineId
  /** A short reason a person can read, e.g. a refusal code. Never a secret. */
  detail?: string
}

export interface CredentialEventDeps {
  settingsAudit: Pick<SettingsAuditRepository, 'append'>
}

export async function recordCredentialEvent(
  deps: CredentialEventDeps,
  i: CredentialEvent,
): Promise<void> {
  await deps.settingsAudit.append({
    command: `credentials.${i.kind}`,
    outcome: i.kind === 'refuse' ? 'refused' : 'applied',
    actorKind: 'user',
    actorId: i.actorUserId,
    onBehalfOf: i.actorUserId,
    detail: {
      credentialId: i.credentialId,
      ...(i.sessionId === undefined ? {} : { sessionId: i.sessionId }),
      ...(i.machineId === undefined ? {} : { machineId: i.machineId }),
      ...(i.detail === undefined ? {} : { detail: i.detail }),
    },
    redactedPaths: [],
    createdAt: new Date().toISOString(),
  })
}
