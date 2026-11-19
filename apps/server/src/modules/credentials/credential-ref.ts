/**
 * WHICH CREDENTIAL A LAUNCH NAMED (credential management §9 "Choosing for a
 * session", epic plan Task 10).
 *
 * A launch names its credential by reference: `none` (the harness's own login),
 * an id, or a label. A label is matched, ignoring case and surrounding space,
 * among the credentials the ACTING person can use (their own and those shared
 * with them), so an agent reaches exactly what the person it acts for may use.
 *
 * Every launch path calls this first, before it writes or starts anything: an
 * unknown or ambiguous reference creates nothing. An id is checked as the
 * resolver checks it (exists, not removed, the person may use it) and refused
 * with the resolver's own sentence and a `refuse` event. An unknown or
 * ambiguous label identified no credential at all, so it is an input error with
 * its own sentence, not one of the access refusals.
 */

import { CREDENTIAL_ID_PREFIX, type CredentialId, type MachineId, type UserId } from '@podium/model'
import { type AccessRefusal, refuse } from './access'
import { listCredentials } from './list'
import { mayUse } from './may-use'
import type { CredentialsStore } from './store-port'

/** The spelling that means "no credential: the harness's own login". */
export const NO_CREDENTIAL_REF = 'none'

export type CredentialRefResult =
  | { ok: true; credentialId: CredentialId | null }
  | { ok: false; message: string; refusal?: AccessRefusal }

/** A launch refused for the credential it named. The message is the sentence a person reads. */
export class CredentialRefError extends Error {
  override readonly name = 'CredentialRefError'

  constructor(
    message: string,
    readonly refusal?: AccessRefusal,
  ) {
    super(message)
  }
}

export type CredentialRefDeps = Pick<
  CredentialsStore,
  'credentials' | 'grants' | 'users' | 'settingsAudit'
>

export async function resolveCredentialRef(
  deps: CredentialRefDeps,
  i: { ref: string; actingUserId: UserId; machineId?: MachineId },
): Promise<CredentialRefResult> {
  const ref = i.ref.trim()
  if (ref.toLowerCase() === NO_CREDENTIAL_REF) return { ok: true, credentialId: null }
  if (ref.startsWith(CREDENTIAL_ID_PREFIX)) return await byId(deps, ref as CredentialId, i)
  const wanted = ref.toLowerCase()
  const matches = (await listCredentials(deps as CredentialsStore, i.actingUserId)).filter(
    (view) => view.label.trim().toLowerCase() === wanted,
  )
  const [only] = matches
  if (matches.length === 1 && only) return { ok: true, credentialId: only.id }
  if (matches.length === 0) {
    return { ok: false, message: `No credential you can use is labelled "${ref}".` }
  }
  const named = matches.map((view) => `"${view.label}" (${view.id})`).join(', ')
  return {
    ok: false,
    message: `The label "${ref}" matches more than one credential: ${named}. Name one by its id.`,
  }
}

/** Resolve, or throw {@link CredentialRefError}; `undefined` (nothing named) passes through. */
export async function credentialIdForRef(
  deps: CredentialRefDeps,
  i: { ref: string | undefined; actingUserId: UserId; machineId?: MachineId },
): Promise<CredentialId | null | undefined> {
  if (i.ref === undefined) return undefined
  const result = await resolveCredentialRef(deps, { ...i, ref: i.ref })
  if (!result.ok) throw new CredentialRefError(result.message, result.refusal)
  return result.credentialId
}

async function byId(
  deps: CredentialRefDeps,
  id: CredentialId,
  i: { actingUserId: UserId; machineId?: MachineId },
): Promise<CredentialRefResult> {
  const record = await deps.credentials.get(id)
  const reason: AccessRefusal | undefined = !record
    ? 'not-found'
    : record.status === 'revoked'
      ? 'revoked'
      : (await mayUse(deps, i.actingUserId, record)) === null
        ? 'not-yours'
        : undefined
  if (reason === undefined) return { ok: true, credentialId: id }
  const refused = await refuse(deps, reason, {
    credentialId: record ? id : null,
    actingUserId: i.actingUserId,
    ...(i.machineId ? { machineId: i.machineId } : {}),
  })
  return { ok: false, refusal: refused.refusal, message: refused.message }
}
