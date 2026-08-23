/**
 * The coordinating host's local update participant.
 *
 * This is not a loopback daemon and does not authenticate to its own server. It
 * registers the existing host machine directly in the machine directory, while
 * every privileged install effect crosses the parent control boundary shared by
 * server-only, daemon-only, and all-in-one topologies.
 */
import type { MachineId } from '@podium/model'
import {
  type PeerBuild,
  type UpdateStatusMessage,
  type UpdateTarget,
  wireSchemaDigest,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { requestParentHandover, requestParentSwap } from '@podium/runtime/parent-control'
import { createGrantRunner } from '@podium/runtime/update-participant'
import { writePendingGrant } from '@podium/runtime/update-pending'

export interface LocalUpdateParticipantDeps {
  machineId: MachineId
  appVersion: string
  runtimeDir: string
  pinnedPubkey?: string
  machines: {
    setMachineBuild(machineId: MachineId, build: PeerBuild, caps: string[], at: string): void
    attachUpdateParticipant(
      machineId: MachineId,
      send: (message: Extract<ControlMessage, { type: 'updateGrant' }>) => void,
    ): void
    detachUpdateParticipant(
      machineId: MachineId,
      send?: (message: Extract<ControlMessage, { type: 'updateGrant' }>) => void,
    ): boolean
  }
  updates: { onStatus(machineId: MachineId, message: UpdateStatusMessage): void }
  installTarget?: (target: UpdateTarget) => Promise<{ releaseHadMigrations?: boolean }>
  writePending?: Parameters<typeof createGrantRunner>[0]['writePending']
  restart?: (expectedVersion: string, handover: { releaseHadMigrations?: boolean }) => void
  connected?: (machineId: MachineId) => void
  now?: () => number
}

export function startLocalUpdateParticipant(deps: LocalUpdateParticipantDeps): { close(): void } {
  const now = deps.now ?? Date.now
  const build: PeerBuild = {
    appVersion: deps.appVersion,
    wireSchemaDigest: wireSchemaDigest(),
    installKind: 'installed',
  }
  const installTarget =
    deps.installTarget ??
    ((target: UpdateTarget) =>
      requestParentSwap({
        expectedVersion: target.version,
        target: target as unknown as Record<string, unknown>,
        ...(deps.pinnedPubkey ? { pinnedPubkey: deps.pinnedPubkey } : {}),
      }))
  const restart =
    deps.restart ??
    ((expectedVersion: string, handover: { releaseHadMigrations?: boolean }) => {
      const result = requestParentHandover({ expectedVersion, ...handover })
      if (!result.ok) {
        throw new Error(
          'machine-cannot-restart: no supervising parent to hand over to (' + result.reason + ')',
        )
      }
    })
  const runner = createGrantRunner({
    currentVersion: () => deps.appVersion,
    caps: ['update.delivery.feed'],
    installTarget,
    writePending: deps.writePending ?? ((pending) => writePendingGrant(deps.runtimeDir, pending)),
    restart,
    report: (status) => deps.updates.onStatus(deps.machineId, status),
    now,
  })
  const receive = (message: Extract<ControlMessage, { type: 'updateGrant' }>): void => {
    void runner.apply(message)
  }

  deps.machines.setMachineBuild(
    deps.machineId,
    build,
    ['update.delivery.feed'],
    new Date(now()).toISOString(),
  )
  deps.machines.attachUpdateParticipant(deps.machineId, receive)
  deps.connected?.(deps.machineId)

  return {
    close: () => {
      deps.machines.detachUpdateParticipant(deps.machineId, receive)
    },
  }
}
