/** Explicit payload repair through the coordinator's ordinary update-grant path. */
import { asMachineId, type MachineId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeOperatorIssueClient } from './operator-client'

interface RepairClient {
  updates: {
    repairPayload: {
      mutate(input?: { id?: MachineId }): Promise<{
        outcome: { result: string; version?: string }
      }>
    }
  }
}

export function coordinatorHttpUrl(serverUrl: string): string {
  return serverUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
}

/**
 * A paired daemon's identity is coordinator-owned and already durable in daemon.json.
 * Repair must name that identity; minting the host-local machine.id here would target a
 * different row on daemon-only Macs.
 */
export function readPairedMachineId(at: string = stateDir()): MachineId {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(at, 'daemon.json'), 'utf8'))
  } catch (error) {
    throw new Error(`cannot read paired machine identity: ${(error as Error).message}`)
  }
  const id = (value as { machineId?: unknown }).machineId
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('paired machine identity is missing from daemon.json')
  }
  return asMachineId(id)
}

export async function runPayloadRepair(options: {
  serverUrl: string
  pairedDaemon: boolean
  client?: RepairClient
  stateDir?: string
}): Promise<void> {
  const client =
    options.client ??
    (makeOperatorIssueClient(coordinatorHttpUrl(options.serverUrl)) as unknown as RepairClient)
  const machineId = options.pairedDaemon ? readPairedMachineId(options.stateDir) : undefined
  const result = await client.updates.repairPayload.mutate(
    machineId === undefined ? undefined : { id: machineId },
  )
  const version = result.outcome.version ? ` ${result.outcome.version}` : ''
  console.log(
    result.outcome.result === 'in-flight'
      ? 'podium payload repair: an update is already in flight'
      : `podium payload repair: grant issued${version}; restart follows verification`,
  )
}
