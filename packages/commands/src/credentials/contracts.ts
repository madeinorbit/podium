/**
 * THE CREDENTIAL CONTRACTS (credential management design §6, §8, §12; epic Task 4).
 *
 * `credentials.add · rename · renew · remove · share · unshare · allowMachine ·
 * disallowMachine`. A credential belongs to the person who added it. Its owner,
 * or a person the owner gave `manage`, may change it; a person with `use` may run
 * on it and change nothing. Being an admin gives no access to another person's
 * credential. Every write is a person's: an agent session is refused, whoever it
 * acts for.
 *
 * Every contract is `secret`, so the lint forces `online-sensitive`: nothing here
 * is queued on a device or replayed later. `add` and `renew` carry the secret and
 * redact it; the results never echo it. The read is the `credentials.list` query.
 */

import { CREDENTIAL_TYPE_IDS, CredentialIdField, MachineIdField, UserIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

/** What a person is told before sharing any credential (§12: use means the other person can obtain it). */
export const CREDENTIAL_SHARE_DISCLOSURE =
  'Anyone you give use of this credential can read it on the machines they run sessions on.'

/** The additional warning before sharing a subscription (types with `sharing: 'warn'`). */
export const CREDENTIAL_SHARE_WARNING =
  'This is a subscription sold to one person. Sharing it may break the provider’s terms and puts your account at risk.'

/** What the owner is told before allowing a machine they do not look after (§8). */
export const CREDENTIAL_MACHINE_DISCLOSURE =
  'Everyone who runs on this machine’s operating-system account will be able to read this credential.'

const SERVED_ON: readonly TransportTag[] = ['trpc']
const VISIBILITY: VisibilityClass = 'secret'

const DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued: a `secret` resource forces `online-sensitive`. A queued `add` would leave the ' +
    'secret in a device outbox until drain, and a queued `remove` or `unshare` would leave access ' +
    'live for the length of an offline window.',
  applyTimeReauthorization:
    'Not reachable, since the class forbids queuing; stated for totality (ADR 3 D8). Owner, ' +
    '`manage` and the person-only check are evaluated at the call.',
}

const ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. Agents are refused, so the ' +
    'actor and the person it acts for are the same person, recorded on each credential event.',
}

/** Commands that name an existing credential: unseen and nonexistent answer alike. */
const NAMED_TARGET: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'A credential the caller may not see answers exactly as one that does not exist, so the ' +
    'reply says nothing about other people’s credentials. A person with `use` sees it, and is ' +
    'told they may not change it.',
}

const NO_SECRET: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note: 'The input names a credential, a label, a person or a machine; none is secret. The result echoes no secret.',
}

const SECRET_IN: RedactionPolicy = {
  reviewed: true,
  inputPaths: ['secret'],
  outputPaths: [],
  note:
    '`secret` is the credential itself and is redacted from every log and audit record. The ' +
    'result is the credential id or `{ ok: true }`; identity shows a masked form only.',
}

const NO_NEW_ROWS = (note: string) => ({ creates: [] as const, note })

const credentialId = CredentialIdField
const label = z.string().trim().min(1).max(80)

export const credentialsAddInput = z.object({
  type: z.enum(CREDENTIAL_TYPE_IDS),
  label,
  secret: z.string().min(1).max(16_384),
})

export const credentialsRenameInput = z.object({ credentialId, label })

export const credentialsRenewInput = z.object({
  credentialId,
  secret: z.string().min(1).max(16_384),
})

export const credentialsRemoveInput = z.object({ credentialId })

/** A person, or every member of the instance. */
export const CredentialGrantee = z.union([
  z.literal('all-members'),
  z.object({ userId: UserIdField }),
])
export type CredentialGrantee = z.infer<typeof CredentialGrantee>

export const CredentialGrantVerb = z.enum(['use', 'manage'])

export const credentialsShareInput = z.object({
  credentialId,
  grantee: CredentialGrantee,
  verb: CredentialGrantVerb,
  /** The person read {@link CREDENTIAL_SHARE_DISCLOSURE}. Required for every type. */
  acknowledgeDisclosure: z.boolean(),
  /** The person read {@link CREDENTIAL_SHARE_WARNING}. Required for subscriptions. */
  acknowledgeWarning: z.boolean().optional(),
})

export const credentialsUnshareInput = z.object({
  credentialId,
  grantee: CredentialGrantee,
  /** Omitted: both verbs. */
  verb: CredentialGrantVerb.optional(),
})

export const credentialsAllowMachineInput = z.object({
  credentialId,
  machineId: MachineIdField,
  /** The owner read {@link CREDENTIAL_MACHINE_DISCLOSURE}. */
  acknowledgeDisclosure: z.boolean(),
})

export const credentialsDisallowMachineInput = z.object({ credentialId, machineId: MachineIdField })

const common = {
  version: 1,
  visibility: VISIBILITY,
  exposure: SERVED_ON,
  delivery: DELIVERY,
  attribution: ATTRIBUTION,
  conflict: 'cmd',
} as const

export const credentialsAddContract = {
  ...common,
  name: 'credentials.add',
  input: credentialsAddInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'A member stores their own key or token (types obtained by pasting). Sealed by the vault ' +
      'before it is written; owned by the caller; private until shared. An agent may not add one ' +
      'for its person.',
  },
  redaction: SECRET_IN,
  ownership: {
    creates: ['credential'],
    owner: 'on-behalf-of-human',
    visibility: VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note: 'Mints a credential owned by the signed-in caller, with no grants.',
  },
  errorConsistency: {
    callerSuppliedTargetId: false,
    note: 'The id is minted by the server; the owner is the caller.',
  },
  conflictRule:
    'The same secret of the same type for the same owner is one credential: a second add is refused and names the first',
} as const satisfies CommandContract<typeof credentialsAddInput>

export const credentialsRenameContract = {
  ...common,
  name: 'credentials.rename',
  input: credentialsRenameInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale: 'Changes the label. Owner or `manage`.',
  },
  redaction: NO_SECRET,
  ownership: NO_NEW_ROWS('Changes the label of an existing credential.'),
  errorConsistency: NAMED_TARGET,
  conflictRule: 'Last write wins',
} as const satisfies CommandContract<typeof credentialsRenameInput>

export const credentialsRenewContract = {
  ...common,
  name: 'credentials.renew',
  input: credentialsRenewInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Stores the next version of the secret under the same id, so every selection keeps ' +
      'pointing at it. Owner or `manage`.',
  },
  redaction: SECRET_IN,
  ownership: NO_NEW_ROWS('Adds a secret version to an existing credential.'),
  errorConsistency: NAMED_TARGET,
  conflictRule:
    'Versioned: a renew that raced another is refused with a conflict and stores nothing',
} as const satisfies CommandContract<typeof credentialsRenewInput>

export const credentialsRemoveContract = {
  ...common,
  name: 'credentials.remove',
  input: credentialsRemoveInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Deletes the stored secret and every grant; the record stays as removed so sessions that ' +
      'name it read "removed". Owner or `manage`.',
  },
  redaction: NO_SECRET,
  ownership: NO_NEW_ROWS('Removes the secret and grants of an existing credential.'),
  errorConsistency: NAMED_TARGET,
  conflictRule: 'Idempotent: removing a removed credential answers not found',
} as const satisfies CommandContract<typeof credentialsRemoveInput>

export const credentialsShareContract = {
  ...common,
  name: 'credentials.share',
  input: credentialsShareInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Gives another member, or all members, `use` (or a member `manage`) as a grant, checked at ' +
      'every use. Owner or `manage`. The caller acknowledges that use discloses the secret, and ' +
      'for a subscription the provider-terms warning too.',
  },
  redaction: NO_SECRET,
  ownership: NO_NEW_ROWS('Writes a grant edge on an existing credential; mints no entity.'),
  errorConsistency: NAMED_TARGET,
  conflictRule: 'Idempotent: sharing the same verb with the same grantee again changes nothing',
} as const satisfies CommandContract<typeof credentialsShareInput>

export const credentialsUnshareContract = {
  ...common,
  name: 'credentials.unshare',
  input: credentialsUnshareInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Takes a grant back; the next launch or call by that person is refused. Owner or `manage`.',
  },
  redaction: NO_SECRET,
  ownership: NO_NEW_ROWS('Deletes grant edges of an existing credential.'),
  errorConsistency: NAMED_TARGET,
  conflictRule: 'Idempotent revocation',
} as const satisfies CommandContract<typeof credentialsUnshareInput>

export const credentialsAllowMachineContract = {
  ...common,
  name: 'credentials.allowMachine',
  input: credentialsAllowMachineInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Lets the credential be delivered to a machine its owner does not look after (§8), after ' +
      'the caller acknowledges who there can read it. Owner or `manage`; an enrolled machine only.',
  },
  redaction: NO_SECRET,
  ownership: NO_NEW_ROWS('Records one allowed machine for an existing credential.'),
  errorConsistency: NAMED_TARGET,
  conflictRule: 'Idempotent',
} as const satisfies CommandContract<typeof credentialsAllowMachineInput>

export const credentialsDisallowMachineContract = {
  ...common,
  name: 'credentials.disallowMachine',
  input: credentialsDisallowMachineInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Takes an allowed machine back; the next launch there is refused. Owner or `manage`.',
  },
  redaction: NO_SECRET,
  ownership: NO_NEW_ROWS('Deletes one allowed machine of an existing credential.'),
  errorConsistency: NAMED_TARGET,
  conflictRule: 'Idempotent revocation',
} as const satisfies CommandContract<typeof credentialsDisallowMachineInput>

export const CREDENTIAL_CONTRACTS = {
  add: credentialsAddContract,
  allowMachine: credentialsAllowMachineContract,
  disallowMachine: credentialsDisallowMachineContract,
  remove: credentialsRemoveContract,
  rename: credentialsRenameContract,
  renew: credentialsRenewContract,
  share: credentialsShareContract,
  unshare: credentialsUnshareContract,
} as const
export type CredentialContractName = keyof typeof CREDENTIAL_CONTRACTS
export const CREDENTIAL_CONTRACT_NAMES = Object.keys(
  CREDENTIAL_CONTRACTS,
).sort() as CredentialContractName[]
