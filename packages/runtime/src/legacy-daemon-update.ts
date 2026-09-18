/** Recovery for plain-service daemons. The known-good launcher stays outside the
 * candidate process: even an executable that dies before main is observable. */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatusMessage } from '@podium/protocol'
import { ensureInstanceStateIdentity } from './instance'
import { acquireStateRootLock } from './instance-guard'
import { recordLegacyMachineRollback } from './machine-update'
import { readDaemonHealth } from './daemon-health'
import { restoreOldBundle } from './update-install'
import { readPendingGrant, writePendingGrant, type PendingGrant } from './update-pending'

export const LEGACY_BOOT_LIMIT = 3
export const LEGACY_HEALTH_WINDOW_MS = 60_000
export const LEGACY_GUARD_ENV = 'PODIUM_LEGACY_DAEMON_GUARD'
export const LEGACY_GUARD_MARKER = '.legacy-daemon-guard'

export interface LegacyUpdateHealth {
  boots: number
  firstBootAt?: number
  healthyAt?: number
  lastExit?: string
  rollbackReason?: string
  restored?: boolean
  rejectedTargets?: Record<string, { grantId: string; reason: string }>
}

export function legacyBootDecision(
  pending: PendingGrant,
  now: number,
): 'boot' | 'restore' | 'settled' {
  const health = pending.legacyHealth
  if (!health || health.healthyAt !== undefined || health.restored) return 'settled'
  if (
    health.rollbackReason ||
    health.boots >= LEGACY_BOOT_LIMIT ||
    (health.firstBootAt !== undefined && now - health.firstBootAt >= LEGACY_HEALTH_WINDOW_MS)
  ) {
    return 'restore'
  }
  return 'boot'
}

export function legacyRollbackRefusal(
  pending: PendingGrant | null,
  target: string,
  retry = false,
  grantId?: string,
): string | undefined {
  const rejection =
    pending?.legacyHealth?.rejectedTargets?.[target] ??
    (pending?.targetVersion === target && pending.legacyHealth?.rollbackReason
      ? { grantId: pending.grantId, reason: pending.legacyHealth.rollbackReason }
      : undefined)
  if (!rejection) return
  if (retry && grantId && grantId !== rejection.grantId) return
  return rejection.reason + '; operator must re-apply this target'
}

export function confirmLegacyHealth(
  runtimeDir: string,
  version: string,
  now = Date.now(),
): boolean {
  const pending = readPendingGrant(runtimeDir)
  if (
    !pending?.legacyHealth ||
    pending.targetVersion !== version ||
    pending.legacyHealth.rollbackReason
  )
    return false
  if (pending.legacyHealth.healthyAt !== undefined) return true
  const firstBootAt = pending.legacyHealth.firstBootAt
  if (firstBootAt === undefined || now - firstBootAt >= LEGACY_HEALTH_WINDOW_MS) return false
  const rejectedTargets = { ...pending.legacyHealth.rejectedTargets }
  delete rejectedTargets[version]
  writePendingGrant(runtimeDir, {
    ...pending,
    legacyHealth: { ...pending.legacyHealth, healthyAt: now, rejectedTargets },
  })
  return true
}

/** Called from the authenticated helloOk callback, and replayed on reconnect. */
export function legacyUpdateStatus(
  runtimeDir: string,
  runningVersion: string,
): UpdateStatusMessage | undefined {
  const pending = readPendingGrant(runtimeDir)
  if (!pending?.legacyHealth) return
  const healthy = confirmLegacyHealth(runtimeDir, runningVersion)
  const reason = pending.legacyHealth.rollbackReason
  if (!reason && !healthy) return
  return {
    type: 'updateStatus',
    grantId: pending.grantId,
    targetVersion: pending.targetVersion,
    state: reason ? 'stuck' : 'current',
    version: runningVersion,
    ...(reason ? { detail: reason } : {}),
  }
}

function installedVersion(installDir: string): string | undefined {
  try {
    return readFileSync(join(installDir, 'VERSION'), 'utf8').trim()
  } catch {
    return undefined
  }
}

/** Persist intent before renaming. A restart between restore and report publication
 * recognizes the restored grant receipt and never tries to restore the consumed .old. */
export function restoreLegacyUpdate(
  runtimeDir: string,
  installDir: string,
  pending: PendingGrant,
): void {
  const health = pending.legacyHealth!
  const reason =
    health.rollbackReason ??
    `rolled back from ${pending.targetVersion}: ${health.lastExit ?? 'health window expired without server acknowledgement'}`
  const restoring = {
    ...pending,
    legacyHealth: {
      ...health,
      rollbackReason: reason,
      rejectedTargets: {
        ...health.rejectedTargets,
        [pending.targetVersion]: { grantId: pending.grantId, reason },
      },
    },
  }
  writePendingGrant(runtimeDir, restoring)
  const receipt = '.legacy-rollback-grant'
  const backup = `${installDir}.old`
  let alreadyRestored = false
  try {
    alreadyRestored = readFileSync(join(installDir, receipt), 'utf8') === pending.grantId
  } catch {}
  if (!alreadyRestored) {
    if (existsSync(backup)) {
      if (installedVersion(backup) !== pending.previousVersion)
        throw new Error('rollback bundle does not match the recorded previous version')
      const fd = openSync(join(backup, receipt), 'w')
      try {
        writeFileSync(fd, pending.grantId)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    restoreOldBundle(installDir)
  }
  recordLegacyMachineRollback(runtimeDir, pending.grantId, reason)
  writePendingGrant(runtimeDir, {
    ...restoring,
    legacyHealth: { ...restoring.legacyHealth, restored: true },
  })
}

export interface LegacyDaemonGuardOptions {
  installDir: string
  stateDir: string
  argv: string[]
  env?: NodeJS.ProcessEnv
}

export async function runLegacyDaemonGuard(options: LegacyDaemonGuardOptions): Promise<number> {
  const runtimeDir = join(options.stateDir, 'runtime')
  const identity = ensureInstanceStateIdentity({
    dir: options.stateDir,
    env: options.env ?? process.env,
  })
  // Distinct from the child's daemon lock: a duplicate launcher must not spend
  // another process's boot budget or restore its live bundle.
  const guard = acquireStateRootLock({
    stateDir: join(runtimeDir, 'legacy-daemon-guard'),
    instanceUuid: identity.instanceUuid,
  })
  // The shipped shim may use this known-good CLI after a service-manager restart.
  if (existsSync(options.installDir))
    writeFileSync(join(options.installDir, LEGACY_GUARD_MARKER), '1\n')
  let stopping = false
  let child: ReturnType<typeof spawn> | undefined
  const stop = () => {
    stopping = true
    child?.kill('SIGTERM')
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    while (!stopping) {
      let pending = readPendingGrant(runtimeDir)
      if (pending && legacyBootDecision(pending, Date.now()) === 'restore') {
        restoreLegacyUpdate(runtimeDir, options.installDir, pending)
        pending = readPendingGrant(runtimeDir)
      }
      const candidate =
        pending?.legacyHealth &&
        legacyBootDecision(pending, Date.now()) === 'boot' &&
        installedVersion(options.installDir) === pending.targetVersion
      if (candidate && pending) {
        pending = {
          ...pending,
          legacyHealth: {
            ...pending.legacyHealth!,
            boots: pending.legacyHealth!.boots + 1,
            firstBootAt: pending.legacyHealth!.firstBootAt ?? Date.now(),
          },
        }
        writePendingGrant(runtimeDir, pending)
      }
      const command = join(options.installDir, 'podium-cli')
      const startedAt = Date.now()
      let stderrTail = ''
      child = spawn(command, options.argv, {
        env: {
          ...(options.env ?? process.env),
          PODIUM_HOME: options.installDir,
          [LEGACY_GUARD_ENV]: 'child',
        },
        stdio: ['inherit', 'inherit', 'pipe'],
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk)
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096)
      })
      let timedOut = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const timer = setInterval(() => {
        if (!candidate) return
        const current = readPendingGrant(runtimeDir)
        if (!current?.legacyHealth || current.legacyHealth.healthyAt !== undefined) {
          clearInterval(timer)
          return
        }
        const observation = readDaemonHealth(options.stateDir)
        if (
          observation &&
          child?.pid !== undefined &&
          observation.processId === child.pid &&
          observation.state === 'connected' &&
          observation.appVersion === current.targetVersion &&
          Date.parse(observation.updatedAt) >= startedAt
        ) {
          confirmLegacyHealth(runtimeDir, current.targetVersion)
          return
        }
        if (
          !timedOut &&
          legacyBootDecision(current, Date.now()) === 'restore' &&
          Date.now() - current.legacyHealth.firstBootAt! >= LEGACY_HEALTH_WINDOW_MS
        ) {
          timedOut = true
          child?.kill('SIGTERM')
          killTimer = setTimeout(() => child?.kill('SIGKILL'), 1_000)
        }
      }, 100)
      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        child!.once('error', (error) =>
          resolve({ code: 1, reason: `could not start: ${error.message}` }),
        )
        child!.once('exit', (code, signal) =>
          resolve({
            code: code ?? 1,
            reason: timedOut
              ? 'health window expired without server acknowledgement'
              : `exited before server acknowledgement (${signal ? `signal ${signal}` : `exit ${code}`})${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`,
          }),
        )
      })
      // An orphan must not keep the recovery guard alive through inherited stderr.
      child.stderr?.destroy()
      clearInterval(timer)
      if (killTimer) clearTimeout(killTimer)
      if (stopping) return result.code
      const current = readPendingGrant(runtimeDir)
      if (
        candidate &&
        current?.grantId === pending?.grantId &&
        current?.legacyHealth &&
        current.legacyHealth.healthyAt === undefined &&
        !current.legacyHealth.restored
      ) {
        writePendingGrant(runtimeDir, {
          ...current,
          legacyHealth: { ...current.legacyHealth, lastExit: result.reason },
        })
        continue
      }
      // The old daemon wrote a marker and exited after swapping. Do not leave the
      // known-good process until its successor has had the bounded health check.
      if (
        current?.legacyHealth &&
        legacyBootDecision(current, Date.now()) !== 'settled' &&
        installedVersion(options.installDir) === current.targetVersion
      )
        continue
      return result.code
    }
    return 0
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    guard.release()
  }
}
