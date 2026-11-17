/**
 * THE ACCOUNT CONTRACTS — `accounts.login · accounts.useOnMyMachines`.
 *
 * What is left of the Accounts hub: a machine's own (native) logins. `login`
 * opens the harness's login terminal on a machine in the caller's custody;
 * `useOnMyMachines` is the D11 tick that copies a login to every machine the
 * caller holds custody of. The stored provider keys this family once held are
 * credentials (`credentials/contracts.ts`; credential management plan Task 21).
 *
 * CLASSIFICATION: `secret`, so a command is never queued and never replayed
 * (`classificationErrors` forces `online-sensitive` delivery for it).
 */

import { HarnessAgent, MachineIdField } from '@podium/model'
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

/** `trpc` alone — the Accounts hub is the only surface that writes these. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/** ADR 1's `managedCredentials` row. */
const ACCOUNT_VISIBILITY: VisibilityClass = 'secret'

/**
 * ADR 3 D4 rule 1, forced by the lint AND correct on its own terms — the matrix
 * row says `never-enqueue` independently, which is the same claim from the other
 * direction. Two mechanisms, neither substituting for the other.
 */
const ACCOUNT_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued. A queued login or tick would act on a machine long after the person asked, ' +
    'when the login it names may have changed.',
  applyTimeReauthorization:
    'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 D8). A ' +
    'credential write is authorized live or not at all.',
}

/** ADR 9 D5 A3 / Amendment 1 D17. For credentials the pair outlives the
 *  credential: rotating a key does not answer "who put the old one here". */
const ACCOUNT_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload — and here the stamping does real ' +
    'work rather than bookkeeping, because an agent must not be able to record a credential as ' +
    'having been ticked by its human.',
}

export const accountsLoginInput = z.object({
  harness: HarnessAgent,
  machineId: MachineIdField.optional(),
})

export const accountsLoginContract = {
  name: 'accounts.login',
  version: 1,
  visibility: 'owned-compute',
  input: accountsLoginInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    machineVerb: 'use',
    rationale:
      'Starts an interactive provider CLI on owned compute. It changes the native account every agent on that host runs with, and a machine’s native logins belong to the person who looks after it (POD-6300), so a member may log in only on a machine in their own custody; on anyone else’s it would replace that person’s login and is refused.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never queued: an operator must be present for the interactive login PTY.',
    applyTimeReauthorization: 'Machine use, for the calling user, is checked live at apply time.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Only harness, machine and session identifiers cross this boundary; provider tokens stay inside the native CLI.',
  },
  ownership: { creates: [], note: 'Creates an ephemeral operator PTY, not a new owned entity.' },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note: 'A selected machine is caller supplied; machine-use errors distinguish access from reachability.',
  },
  conflict: 'cmd',
  conflictRule: 'One active login attempt per (member, harness) is reused until it settles.',
} as const satisfies CommandContract<typeof accountsLoginInput>

/**
 * `accounts.useOnMyMachines` — THE D11 CHECKBOX (POD-6301; design §2.5, §4.6;
 * September addendum §4-5). One native login, named by harness and identity
 * fingerprint, is ticked or unticked for "use this connection on all machines I
 * hold custody of, now and in future".
 */
export const accountsUseOnMyMachinesInput = z.object({
  harness: HarnessAgent,
  /** The login's identity fingerprint, as the Accounts list reports it. */
  fingerprint: z.string().min(1).max(256),
  enabled: z.boolean(),
})

export const accountsUseOnMyMachinesContract = {
  name: 'accounts.useOnMyMachines',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsUseOnMyMachinesInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Decides whether Podium copies the caller’s OWN native login to the other machines in the ' +
      'caller’s custody and uses it there. Only the caller’s custody machines are ever reached, ' +
      'so the member floor widens nobody’s reach. Ticking a login is refused unless it is ' +
      'observed on one of the caller’s own machines. No confirmation: ticking copies only into ' +
      'empty slots of the caller’s own machines, never over another login, and unticking only ' +
      'stops future copies (it recalls nothing, which the UI says once beside the box).',
  },
  exposure: SERVED_ON,
  delivery: ACCOUNT_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The input names a harness and an identity fingerprint (a one-way hash of the account id), ' +
      'never credential material. The result is `{ ok, enabled }`.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: ['native-login opt-in'],
    owner: 'on-behalf-of-human',
    visibility: ACCOUNT_VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note: 'The choice belongs to the human it was made on behalf of; nobody else reads or changes it.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A fingerprint not observed on one of the caller’s own machines is refused exactly like one ' +
      'that exists nowhere, so the command says nothing about other members’ logins.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule:
    'Last write wins per (member, harness, fingerprint); every change bumps the revision, so a copy exported under the old choice is refused as stale',
} as const satisfies CommandContract<typeof accountsUseOnMyMachinesInput>

export const ACCOUNT_CONTRACTS = {
  login: accountsLoginContract,
  useOnMyMachines: accountsUseOnMyMachinesContract,
} as const

export type AccountContractName = keyof typeof ACCOUNT_CONTRACTS

export const ACCOUNT_CONTRACT_NAMES = Object.keys(ACCOUNT_CONTRACTS).sort() as AccountContractName[]
