/**
 * WHY A CREDENTIAL COULD NOT BE USED (credential management §9 "The resolver").
 *
 * A closed list, each with the one sentence a person reads. The server's
 * resolver refuses with these (`apps/server/src/modules/credentials/access.ts`
 * re-exports them); a client reads a refusal by its CODE, never by matching
 * the sentence, so rewording a sentence changes no behaviour.
 */

export const ACCESS_REFUSALS = [
  'not-found',
  'not-yours',
  'wrong-type',
  'not-on-this-machine',
  'machine-not-allowed',
  'own-credential-required',
  'needs-attention',
  'revoked',
  'daemon-too-old',
  'connection-not-encrypted',
  'machine-offline',
] as const

export type AccessRefusal = (typeof ACCESS_REFUSALS)[number]

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

export function isAccessRefusal(value: unknown): value is AccessRefusal {
  return typeof value === 'string' && (ACCESS_REFUSALS as readonly string[]).includes(value)
}

const CODE_PREFIX = 'credential:'

/** The error code a launch refused for its credential records: `credential:<refusal>`. */
export function credentialRefusalCode(refusal: AccessRefusal): string {
  return `${CODE_PREFIX}${refusal}`
}

/** The refusal an error code names, if it is a credential refusal's code. */
export function credentialRefusalOfCode(code: string | undefined): AccessRefusal | undefined {
  if (!code?.startsWith(CODE_PREFIX)) return undefined
  const refusal = code.slice(CODE_PREFIX.length)
  return isAccessRefusal(refusal) ? refusal : undefined
}
