/**
 * A machine's spec edits as a test sends them (POD-6644): `records.machine.edit`
 * on the sync write entry, the one path a rename or an update-channel pin takes
 * since `machines.rename` and `machines.setUpdateChannel` were removed.
 */

import { asMutationId, type UpdateChannel } from '@podium/model'

interface SubmitCaller {
  readonly sync: {
    submit(envelope: {
      mutationId: ReturnType<typeof asMutationId>
      command: string
      version: number
      input: unknown
    }): Promise<{ outcome: string; refusal?: unknown }>
  }
}

async function editMachine(
  call: SubmitCaller,
  id: string,
  patch: { name?: string; updateChannelOverride?: UpdateChannel | null },
): Promise<void> {
  const reply = await call.sync.submit({
    mutationId: asMutationId(`machine-edit-${crypto.randomUUID()}`),
    command: 'records.machine.edit',
    version: 1,
    input: { id, patch },
  })
  if (reply.outcome !== 'applied') {
    throw new Error(`records.machine.edit ${reply.outcome}: ${JSON.stringify(reply.refusal)}`)
  }
}

/** Rename a machine; throws when the edit is refused, as the old route did. */
export async function renameMachine(call: SubmitCaller, id: string, name: string): Promise<void> {
  await editMachine(call, id, { name })
}

/** Pin (or with `null` unpin) a machine's update channel; throws when refused. */
export async function pinMachineChannel(
  call: SubmitCaller,
  id: string,
  channel: UpdateChannel | null,
): Promise<void> {
  await editMachine(call, id, { updateChannelOverride: channel })
}
