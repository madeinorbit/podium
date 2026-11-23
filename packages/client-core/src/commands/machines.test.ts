import { asMachineId } from '@podium/model'
import { beforeAll, describe, expect, it } from 'vitest'
import { createRecordsApi, loadRecordDeclarations } from '../records'
import { createMachinesCommands } from './machines'

beforeAll(loadRecordDeclarations)

describe('machine commands preserve the generic record write path', () => {
  it('edits the name and update-channel override, including following the fleet default', async () => {
    const queued: { kind: string; input: unknown }[] = []
    const records = createRecordsApi(async (kind, input) => {
      queued.push({ kind, input })
    })
    const commands = createMachinesCommands({ editRecord: records.edit, reportFailure: () => {} })
    const id = asMachineId('machine-commands')

    await commands.rename(id, 'Desk')
    await commands.setUpdateChannel(id, 'edge')
    await commands.setUpdateChannel(id, null)

    expect(queued).toEqual([
      { kind: 'recordEdit', input: { kind: 'machine', id, patch: { name: 'Desk' } } },
      {
        kind: 'recordEdit',
        input: { kind: 'machine', id, patch: { updateChannelOverride: 'edge' } },
      },
      {
        kind: 'recordEdit',
        input: { kind: 'machine', id, patch: { updateChannelOverride: null } },
      },
    ])
  })
})
