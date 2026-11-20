import { MachineIdField } from '@podium/model'
import { HarnessInstallAction, InstallHarness } from '@podium/protocol'
import { z } from 'zod'
import type { CommandContract } from '../contract'

export const harnessInstallActionInput = z.object({
  machineId: MachineIdField,
  harness: InstallHarness,
  action: HarnessInstallAction,
})

/** Online machine controls: the daemon reports facts through inventory, never a server write. */
export const harnessInstallActionContract = {
  name: 'harnessInstalls.action',
  version: 1,
  visibility: 'owned-compute',
  input: harnessInstallActionInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'An explicit request changes only Podium-owned harness releases or reverses recorded Podium edits. Machine manage is checked live. Home deletion is a separate confirmed action.',
  },
  exposure: ['trpc', 'relay'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never queued: the person is acting on the current state of a connected machine.',
    applyTimeReauthorization:
      'The handler checks live machine grants before sending any request to its daemon.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Harness identifiers, release versions and recorded posture changes carry no login or credential material. Machine access gates the result.',
  },
  ownership: {
    creates: [],
    note: 'Releases are owned by the selected machine instance. No server entity is created.',
  },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'separate-field',
    reservedWireKeys: ['actor', 'onBehalfOf'],
    rationale: 'The explicit action is the request. The daemon records requested.by as person.',
  },
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note: 'An invisible machine is absent; insufficient management permission and an offline machine have distinct reasons.',
  },
  conflict: 'single-writer',
} as const satisfies CommandContract<typeof harnessInstallActionInput>
