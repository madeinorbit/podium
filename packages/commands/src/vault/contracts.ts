/**
 * THE VAULT CONTRACTS (credential management design §7; POD-6889).
 *
 * `vault.reset` is the way out when the vault's outside key (its key file) is lost
 * for good: it deletes the wrapped data key and every secret sealed under it, and
 * moves the affected credentials to "needs attention" so their owners add them
 * again. Nothing else is lost. `vault.status` is a query (the server's query
 * table), not a contract: a read writes nothing.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

const SERVED_ON: readonly TransportTag[] = ['trpc']

/** ADR 3 D4 rule 1: a `secret` resource is never queued and never replayed. */
const SECRET_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued: a `secret` resource forces `online-sensitive`. A reset replayed from a queue ' +
    'after the operator restored the key file would destroy credentials that had become readable again.',
  applyTimeReauthorization:
    'Not reachable, since the class forbids queuing; stated for totality (ADR 3 D8). The admin floor ' +
    'and the human-only check are evaluated at the call.',
}

const ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. The reset is recorded as a ' +
    'credential event per affected credential, attributed to the admin who ran it.',
}

const NO_TARGET: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note: 'No entity id: the target is the vault of the instance the caller reached.',
}

export const vaultResetInput = z.object({
  /** The caller confirms that every stored secret is deleted. */
  confirm: z.literal(true),
})
export type VaultResetInput = z.infer<typeof vaultResetInput>

export const vaultResetContract = {
  name: 'vault.reset',
  version: 1,
  visibility: 'secret',
  input: vaultResetInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'DESTRUCTIVE AND INSTANCE-WIDE: deletes every secret Podium holds, whoever owns it. Only an ' +
      'admin person may do it, never an agent (the handler refuses any principal that is not a ' +
      'user), and the input carries an explicit `confirm: true` on top of the contract confirmation. ' +
      'It exists for one situation, a lost key file, where the secrets are unreadable already.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'No secret crosses: the input is a confirmation flag and the result is the number of credentials that now need attention.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note: 'Deletes the vault data key and every sealed secret; moves credentials to attention. Mints nothing.',
  },
  attribution: ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'Idempotent: a second reset finds no data key and no secret and changes nothing further.',
} as const satisfies CommandContract<typeof vaultResetInput>

export const VAULT_CONTRACTS = {
  reset: vaultResetContract,
} as const
export type VaultContractName = keyof typeof VAULT_CONTRACTS
export const VAULT_CONTRACT_NAMES = Object.keys(VAULT_CONTRACTS).sort() as VaultContractName[]
