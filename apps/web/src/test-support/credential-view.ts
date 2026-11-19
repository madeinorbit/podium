import type { CredentialView } from '@podium/model'

let seq = 0

/** A credential as `credentials.list` returns it; planted values only, never a real secret.
 *  Ids are plain strings here; the view brands them. */
export function credentialView(
  over: { [K in keyof CredentialView]?: unknown } = {},
): CredentialView {
  seq++
  return {
    id: `cred_00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    ownerUserId: 'user:me',
    label: 'Work key',
    type: 'anthropic.api-key',
    identity: { masked: 'sk-a…1234' },
    status: 'ok',
    homes: [],
    allowedMachines: [],
    sessionCount: 0,
    access: 'owner',
    ...over,
  } as CredentialView
}
