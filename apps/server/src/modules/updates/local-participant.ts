/**
 * The coordinating host's local update participant.
 *
 * This is not a loopback daemon and does not authenticate to its own server. It
 * registers the existing host machine directly in the machine directory, while
 * every privileged install effect crosses the parent control boundary shared by
 * server-only, daemon-only, and all-in-one topologies.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import {
  type PeerBuild,
  type UpdateStatusMessage,
  type UpdateTarget,
  wireSchemaDigest,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { resolveInstallDir } from '@podium/runtime/config'
import { requestParentHandover, requestParentSwap } from '@podium/runtime/parent-control'
import { createGrantRunner } from '@podium/runtime/update-participant'
import { writePendingGrant } from '@podium/runtime/update-pending'

const log = createLogger('server:updates')

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
    report: (status) => {
      // Every convergence decision, INCLUDING the ones that do nothing. Four
      // days of a coordinator silently judged already-current is what made this
      // line a requirement, not a nicety (POD-2732): a skipped machine that
      // logs nothing is indistinguishable from a machine that never got the
      // grant.
      log.info('local update participant status', {
        grantId: status.grantId,
        state: status.state,
        version: status.version,
        ...(status.detail ? { detail: status.detail } : {}),
      })
      deps.updates.onStatus(deps.machineId, status)
    },
    now,
  })
  // FOR THE LOG LINE ONLY — convergence is decided on the process identity
  // (see the revert of 53b269c71's disk-read: a post-swap re-delivered grant
  // would read the target off disk, report already-current, and never ask for
  // the restart). The disk fact still belongs in the log, because process ≠
  // install divergence is exactly the state worth seeing in one line.
  const installedVersionForLog = (): string | undefined => {
    try {
      return readFileSync(join(resolveInstallDir(), 'VERSION'), 'utf8').trim() || undefined
    } catch {
      return undefined
    }
  }
  const receive = (message: Extract<ControlMessage, { type: 'updateGrant' }>): void => {
    log.info('local update participant received grant', {
      grantId: message.grantId,
      targetVersion: message.target.version,
      currentVersion: deps.appVersion,
      ...(installedVersionForLog() !== undefined
        ? { installedVersion: installedVersionForLog() }
        : {}),
    })
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
