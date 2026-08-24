import type {
  ConvergenceState,
  UpdateArtifact,
  UpdateGrantMessage,
  UpdateStatusMessage,
  UpdateTrustRoot,
} from '@podium/protocol'
import { planConvergence } from '@podium/protocol'
import type { PendingGrant } from './update-pending'

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' }>['platforms'][string]

export type GrantArtifact = { bytes: Uint8Array }

export interface GrantProgress {
  phase: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

export interface GrantApplyDeps {
  currentVersion(): string
  caps: readonly string[]
  platform?: string
  fetchArtifact?(
    asset: PlatformAsset,
    trust: UpdateTrustRoot | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: GrantProgress) => void,
  ): Promise<GrantArtifact>
  swap?(bytes: Uint8Array): void | Promise<void>
  /** A supervised participant delegates verified installation to its parent. */
  installTarget?(target: UpdateGrantMessage['target']): Promise<{ releaseHadMigrations?: boolean }>
  refuse?(target: UpdateGrantMessage['target']): string | undefined
  releaseHadMigrations?(target: UpdateGrantMessage['target']): boolean | undefined
  writePending(grant: PendingGrant): void
  restart(expectedVersion: string, handover: { releaseHadMigrations?: boolean }): void
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
  progress?: GrantProgress,
): void {
  deps.report({
    type: 'updateStatus',
    grantId: grant.grantId,
    state,
    version,
    ...(detail ? { detail } : {}),
    ...(progress?.percent !== undefined ? { percent: progress.percent } : {}),
    ...(progress?.phase ? { phaseDetail: progress.phase } : {}),
  })
}

/** One grant workflow for every topology and transport. */
export async function applyGrant(
  grant: UpdateGrantMessage,
  deps: GrantApplyDeps,
  signal?: AbortSignal,
): Promise<void> {
  /**
   * EVERY PATH OUT OF HERE REPORTS, INCLUDING THE ONES THAT THROW (POD-2741).
   *
   * The coordinator marks a machine `granted` the moment it hands the grant
   * over, and the only thing that can move that place again is a status report
   * from this function. Deciding whether to converge used to sit OUTSIDE the
   * try below — `currentVersion`, `planConvergence`, and `refuse`, which is the
   * daemon's schema gate — and `local-participant.ts` calls this through a
   * floating `void runner.apply(...)`. So a gate that threw instead of
   * answering was swallowed whole: no report, no rejection, and a wave left
   * holding a machine that was neither working nor failed until the machines
   * step spent its entire silence budget.
   *
   * `current` is declared before the try so a throw in `currentVersion` itself
   * still reports against a version rather than losing the report too.
   */
  let current = ''
  try {
    current = deps.currentVersion()
    const plan = planConvergence({
      current,
      target: grant.target,
      caps: deps.caps,
      platform: deps.platform ?? runningPlatform(),
      repair: grant.repair === true,
    })

    if (plan.action === 'already-current') {
      report(deps, grant, 'current', current)
      return
    }
    if (plan.action === 'cannot') {
      report(deps, grant, 'rejected', current, `cannot converge: ${plan.reason}`)
      return
    }
    const refusal = deps.refuse?.(grant.target)
    if (refusal) {
      report(deps, grant, 'rejected', current, refusal)
      return
    }

    report(deps, grant, 'downloading', current)
    let parentResult: { releaseHadMigrations?: boolean } | undefined
    if (deps.installTarget) {
      parentResult = await deps.installTarget(grant.target)
    } else {
      if (!deps.fetchArtifact || !deps.swap) {
        throw new Error('update participant has no installation capability')
      }
      const artifact = await deps.fetchArtifact(
        plan.asset,
        grant.target.trust,
        signal,
        (progress) => {
          if (signal?.aborted) return
          report(deps, grant, 'downloading', current, undefined, progress)
        },
      )
      if (signal?.aborted) return
      await deps.swap(artifact.bytes)
    }
    if (signal?.aborted) return
    deps.writePending({
      grantId: grant.grantId,
      targetVersion: grant.target.version,
      previousVersion: current,
      attempts: 1,
      startedAt: deps.now(),
    })
    report(deps, grant, 'restarting', current)
    const releaseHadMigrations =
      parentResult?.releaseHadMigrations ?? deps.releaseHadMigrations?.(grant.target)
    deps.restart(
      grant.target.version,
      releaseHadMigrations === undefined ? {} : { releaseHadMigrations },
    )
  } catch (error) {
    if (signal?.aborted) return
    report(deps, grant, 'rejected', current, error instanceof Error ? error.message : String(error))
  }
}

export function createGrantRunner(deps: GrantApplyDeps): {
  apply(grant: UpdateGrantMessage): Promise<void>
} {
  let active: {
    grantId: string
    abort: AbortController
    done: Promise<void>
  } | null = null

  return {
    async apply(grant: UpdateGrantMessage): Promise<void> {
      if (active?.grantId === grant.grantId) return active.done
      if (active) {
        active.abort.abort()
        await active.done.catch(() => {})
      }
      const abort = new AbortController()
      const done = applyGrant(grant, deps, abort.signal).finally(() => {
        if (active?.grantId === grant.grantId) active = null
      })
      active = { grantId: grant.grantId, abort, done }
      return done
    },
  }
}
