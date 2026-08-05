import type {
  ConvergenceState,
  UpdateArtifact,
  UpdateGrantMessage,
  UpdateStatusMessage,
} from '@podium/protocol'
import { planConvergence } from '@podium/protocol'
import type { PendingGrant } from './pending-grant'

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' | 'bundle' }>['platforms'][string]
type GitArtifact = Extract<UpdateArtifact, { delivery: 'git' }>

/** The delivery result is deliberately small: verification happens before this seam. */
export type GrantArtifact = { bytes: Uint8Array } | { git: true }

export interface GrantApplyDeps {
  /** Read the label currently running, without ordering or semver parsing it. */
  currentVersion(): string
  /** Capabilities offered by this daemon's authenticated build report. */
  caps: readonly string[]
  /** The running target triple; platform selection must happen before delivery. */
  platform?: string
  /** Fetch and verify the already-resolved platform asset. */
  fetchArtifact(
    asset: PlatformAsset | GitArtifact,
    delivery: UpdateArtifact['delivery'],
  ): Promise<GrantArtifact>
  /** Binary swap only. Database state is intentionally not part of this phase. */
  swap(bytes: Uint8Array): void | Promise<void>
  /** Persist before asking the process manager to restart us. */
  writePending(grant: PendingGrant): void
  restart(): void
  report(status: UpdateStatusMessage): void
  now(): number
}

function runningPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${os}-${cpu}`
}

function report(
  deps: GrantApplyDeps,
  grant: UpdateGrantMessage,
  state: ConvergenceState,
  version: string,
  detail?: string,
): void {
  deps.report({
    type: 'updateStatus',
    grantId: grant.grantId,
    state,
    version,
    ...(detail ? { detail } : {}),
  })
}

/**
 * Apply one server grant. Every effect is injected so this sequence can be tested
 * without a socket, filesystem, process restart, or wall clock.
 *
 * The order is part of the safety contract: report downloading, verify and fetch,
 * swap the binary, write the rollback marker, report restarting, then restart.
 */
export async function applyGrant(grant: UpdateGrantMessage, deps: GrantApplyDeps): Promise<void> {
  const current = deps.currentVersion()
  const plan = planConvergence({
    current,
    target: grant.target,
    caps: deps.caps,
    platform: deps.platform ?? runningPlatform(),
  })

  if (plan.action === 'already-current') {
    report(deps, grant, 'current', current)
    return
  }
  if (plan.action === 'cannot') {
    report(deps, grant, 'rejected', current, `cannot converge: ${plan.reason}`)
    return
  }
  report(deps, grant, 'downloading', current)
  try {
    const asset = plan.delivery === 'git' ? plan.artifact : plan.asset
    const artifact = await deps.fetchArtifact(asset, plan.delivery)
    if ('bytes' in artifact) await deps.swap(artifact.bytes)
    deps.writePending({
      grantId: grant.grantId,
      targetVersion: grant.target.version,
      previousVersion: current,
      attempts: 1,
      startedAt: deps.now(),
    })
    report(deps, grant, 'restarting', current)
    deps.restart()
  } catch (error) {
    report(deps, grant, 'rejected', current, error instanceof Error ? error.message : String(error))
  }
}
