import type {
  ConvergenceState,
  UpdateArtifact,
  UpdateGrantMessage,
  UpdateStatusMessage,
  UpdateTrustRoot,
} from '@podium/protocol'
import { convergenceRefusal, planConvergence } from '@podium/protocol'
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
    publisherPubkey?: string,
  ): Promise<GrantArtifact>
  swap?(bytes: Uint8Array): void | Promise<void>
  /** A supervised participant delegates verified installation to its parent. */
  installTarget?(
    target: UpdateGrantMessage['target'],
    publisherPubkey?: string,
  ): Promise<{ releaseHadMigrations?: boolean }>
  refuse?(target: UpdateGrantMessage['target']): string | undefined
  releaseHadMigrations?(target: UpdateGrantMessage['target']): boolean | undefined
  writePending(grant: PendingGrant): void
  restart(expectedVersion: string, handover: { releaseHadMigrations?: boolean }): void
  report(status: UpdateStatusMessage): void
  /**
   * ONE LINE PER PHASE BOUNDARY, ON THE MACHINE DOING THE WORK (POD-3170).
   *
   * `report` is not this. A report is a frame on a socket, and the socket is
   * exactly what a coordinator restart takes away — so the whole of what a
   * remote machine did during a lost grant was recorded nowhere, on either
   * side. Attributing a seven-minute update meant timing an artifact route by
   * hand afterwards, because the machine itself had left no trace of whether it
   * had downloaded anything at all.
   *
   * This goes to the host's own log, which survives the link, the grant and the
   * process being replaced. Optional so a fixture need not state one.
   */
  log?(event: string, fields: Record<string, unknown>): void
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
    const platform = deps.platform ?? runningPlatform()
    const plan = planConvergence({
      current,
      target: grant.target,
      caps: deps.caps,
      platform,
      repair: grant.repair === true,
    })

    if (plan.action === 'already-current') {
      report(deps, grant, 'current', current)
      return
    }
    if (plan.action === 'cannot') {
      /**
       * THE REFUSAL SAYS WHICH PLATFORM AND WHICH RELEASE (POD-2783).
       *
       * This used to interpolate the bare reason, and `unsupported-platform`
       * alone is what let the panel above it send an operator to check a
       * release that is immutable. The constructor lives in the protocol
       * because the classifier that reads this sentence lives there too.
       */
      report(
        deps,
        grant,
        'rejected',
        current,
        convergenceRefusal(plan, { platform, target: grant.target }),
      )
      return
    }
    const refusal = deps.refuse?.(grant.target)
    if (refusal) {
      report(deps, grant, 'rejected', current, refusal)
      return
    }

    const startedAt = deps.now()
    /** Elapsed since this grant began — the number every phase line is about. */
    const sinceMs = () => deps.now() - startedAt
    const phase = (event: string, fields: Record<string, unknown> = {}) =>
      deps.log?.(event, {
        grantId: grant.grantId,
        targetVersion: grant.target.version,
        fromVersion: current,
        sinceGrantMs: sinceMs(),
        ...fields,
      })
    phase('update grant accepted', { action: plan.action })

    report(deps, grant, 'downloading', current)
    let parentResult: { releaseHadMigrations?: boolean } | undefined
    if (deps.installTarget) {
      // The supervised path: the parent verifies and places the bytes, so the
      // download, the signature check and the swap are all inside this one
      // await and only its total is this process's to measure.
      const delegatedAt = sinceMs()
      parentResult = await deps.installTarget(grant.target, grant.updatePubkey)
      phase('update parent install finished', { installMs: sinceMs() - delegatedAt })
    } else {
      if (!deps.fetchArtifact || !deps.swap) {
        throw new Error('update participant has no installation capability')
      }
      const downloadAt = sinceMs()
      const artifact = await deps.fetchArtifact(
        plan.asset,
        grant.target.trust,
        signal,
        (progress) => {
          if (signal?.aborted) return
          report(deps, grant, 'downloading', current, undefined, progress)
        },
        grant.updatePubkey,
      )
      if (signal?.aborted) return
      // VERIFIED BYTES, and the size with them: "the download was slow" and
      // "the artifact was large" are different findings and were previously
      // indistinguishable from anything this machine wrote down.
      phase('update artifact verified', {
        downloadMs: sinceMs() - downloadAt,
        bytes: artifact.bytes.byteLength,
      })
      const swapAt = sinceMs()
      await deps.swap(artifact.bytes)
      phase('update bundle swapped', { swapMs: sinceMs() - swapAt })
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
    // The last line this process writes about this grant. Anything after it
    // belongs to the successor, which is why the total is stated HERE.
    phase('update restarting into successor', { totalMs: sinceMs() })
    const releaseHadMigrations =
      parentResult?.releaseHadMigrations ?? deps.releaseHadMigrations?.(grant.target)
    deps.restart(
      grant.target.version,
      releaseHadMigrations === undefined ? {} : { releaseHadMigrations },
    )
  } catch (error) {
    if (signal?.aborted) return
    const detail = error instanceof Error ? error.message : String(error)
    /**
     * WRITTEN DOWN LOCALLY BEFORE IT IS REPORTED, because the failure this most
     * needs to explain is the one where the report cannot arrive: the
     * coordinator that granted this is also the host serving the artifact, and
     * a download that dies because that host restarted dies together with the
     * socket that would have said so.
     */
    deps.log?.('update grant failed', {
      grantId: grant.grantId,
      targetVersion: grant.target.version,
      fromVersion: current,
      detail,
    })
    report(deps, grant, 'rejected', current, detail)
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
