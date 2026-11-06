import { type MachineId, resolveMachineChannel, type UpdateChannel } from '@podium/model'
import {
  UPDATE_SPACE_TIMEOUT_MS,
  type UpdateSpaceEstimate,
  type UpdateSpacePreview,
  type UpdateTarget,
  unknownUpdateSpace,
} from '@podium/protocol'
import { updateFingerprint } from '@podium/runtime/machine-update'
import type { MachineRecord } from '../../store'
import type { ServerPlacement } from './service'
import { isPackagedRolloutTarget, machineCanUseTargetTrust } from './wave'

export interface SpacePreviewDeps {
  machines(): Promise<MachineRecord[]>
  canSee(machineId: MachineId): boolean
  target(channel: UpdateChannel): UpdateTarget | undefined
  fleetChannel: UpdateChannel
  placement: ServerPlacement
  check(
    machineId: MachineId,
    target: UpdateTarget,
    fingerprint: string,
  ): Promise<UpdateSpaceEstimate>
}

/** A single database read, no fleet(), reconciliation, publication, or grants. */
export async function readUpdateSpacePreview(
  deps: SpacePreviewDeps,
  input: { scope?: 'operation' | 'all'; expectedVersion?: string } = {},
): Promise<UpdateSpacePreview> {
  const rows = await deps.machines()
  const placement = deps.placement
  const host =
    placement.kind === 'fleet'
      ? rows.find((machine) => machine.id === placement.machineId)
      : undefined
  const operationChannel = resolveMachineChannel(host?.updateChannelOverride, deps.fleetChannel)
  const selected = rows
    .flatMap((machine) => {
      if (!deps.canSee(machine.id) || machine.revokedAt || machine.supersededBy) return []
      const channel = resolveMachineChannel(machine.updateChannelOverride, deps.fleetChannel)
      if (input.scope !== 'all' && channel !== operationChannel) return []
      const target = deps.target(channel)
      if (
        !target ||
        (input.expectedVersion !== undefined && target.version !== input.expectedVersion) ||
        machine.appVersion === target.version
      )
        return []
      if (
        !isPackagedRolloutTarget({ installKind: machine.installKind ?? undefined }) &&
        machine !== host
      )
        return []
      if (!machineCanUseTargetTrust(machine, target.trust)) return []
      return [{ machine, channel, target, fingerprint: updateFingerprint(target) }]
    })
    .slice(0, 256)
  const machines: UpdateSpacePreview['machines'] = []
  const deadline = Date.now() + UPDATE_SPACE_TIMEOUT_MS
  // Bound preview fan-out without tying up the machine/update control dispatcher.
  for (let offset = 0; offset < selected.length; offset += 8) {
    if (Date.now() >= deadline) {
      machines.push(
        ...selected.slice(offset).map((entry) => ({
          ...unknownUpdateSpace('The space preview budget expired; check again.'),
          machineId: entry.machine.id,
          name: entry.machine.name,
          targetVersion: entry.target.version,
        })),
      )
      break
    }
    machines.push(
      ...(await Promise.all(
        selected.slice(offset, offset + 8).map(async (entry) => {
          let estimate: UpdateSpaceEstimate
          try {
            estimate = await deps.check(entry.machine.id, entry.target, entry.fingerprint)
          } catch {
            estimate = unknownUpdateSpace('Space could not be verified.')
          }
          const currentTarget = deps.target(entry.channel)
          if (!currentTarget || updateFingerprint(currentTarget) !== entry.fingerprint)
            estimate = unknownUpdateSpace('The update changed; check space again.')
          return {
            ...estimate,
            machineId: entry.machine.id,
            name: entry.machine.name,
            targetVersion: entry.target.version,
          }
        }),
      )),
    )
  }
  return { machines }
}
