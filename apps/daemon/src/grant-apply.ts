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

/**
 * What a delivery in flight says about itself — structurally `DeliveryProgress`
 * from `@podium/runtime/update-delivery`, restated here so this file keeps
 * depending on nothing but the protocol it reports over.
 *
 * The CADENCE IS NOT DECIDED HERE. Delivery already gates its reports (every
 * 2 s or every 5 points, `decideProgressReport`), so every call becomes a frame:
 * two places deciding when to speak is how one of them ends up silent.
 */
export interface GrantProgress {
  phase: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

export interface GrantApplyDeps {
  /** Read the label currently running, without ordering or semver parsing it. */
  currentVersion(): string
  /** Capabilities offered by this daemon's authenticated build report. */
  caps: readonly string[]
  /** The running target triple; platform selection must happen before delivery. */
  platform?: string
  /**
   * Fetch and verify the already-resolved platform asset. The signal is raised
   * when a newer grant supersedes this one.
   *
   * Only the network delivery paths can honour it mid-flight. GIT DELIVERY IS
   * SYNCHRONOUS: it blocks this thread until its steps finish or hit their own
   * spawn timeout, so cancellation there means "its result is discarded", not
   * "it stopped". The guard after the await is what makes that safe.
   */
  fetchArtifact(
    asset: PlatformAsset | GitArtifact,
    delivery: UpdateArtifact['delivery'],
    signal?: AbortSignal,
    onProgress?: (progress: GrantProgress) => void,
  ): Promise<GrantArtifact>
  /** Binary swap only. Database state is intentionally not part of this phase. */
  swap(bytes: Uint8Array): void | Promise<void>
  /**
   * Why this daemon must not converge TO THIS TARGET, checked before any byte
   * is fetched and any checkout is moved (POD-2210, POD-2213). Absent, or
   * answering `undefined`, is the ordinary daemon that may.
   *
   * A first-person refusal, and it has to be: the server can only know what a
   * daemon tells it, and this daemon's reasons — its exit would stop the server
   * sharing its process; its database has migrated past what that build can
   * open — are not facts about the release, the platform or the delivery
   * method, which is everything the caps negotiation can express.
   *
   * The TARGET is handed over because the second reason depends on it: the same
   * daemon may converge happily to one version and be unable to survive
   * another.
   */
  refuse?(target: UpdateGrantMessage['target']): string | undefined
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

/**
 * Apply one server grant. Every effect is injected so this sequence can be tested
 * without a socket, filesystem, process restart, or wall clock.
 *
 * The order is part of the safety contract: report downloading, verify and fetch,
 * swap the binary, write the rollback marker, report restarting, then restart.
 */
export async function applyGrant(
  grant: UpdateGrantMessage,
  deps: GrantApplyDeps,
  signal?: AbortSignal,
): Promise<void> {
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
  /**
   * AFTER `already-current`, BEFORE `downloading` (POD-2210, POD-2213).
   *
   * After, because a daemon that is already on the target has nothing to refuse
   * and saying `current` keeps its fleet row true. Before, because the whole
   * value of this refusal is that nothing was fetched, swapped or checked out —
   * see `refuseConvergence` for why a half-applied convergence is worse here
   * than a refused one, and `refuseSchemaRegression` for the refusal where
   * "later" would mean a server that cannot open its own database and cannot be
   * updated back.
   */
  const refusal = deps.refuse?.(grant.target)
  if (refusal) {
    report(deps, grant, 'rejected', current, refusal)
    return
  }
  report(deps, grant, 'downloading', current)
  try {
    const asset = plan.delivery === 'git' ? plan.artifact : plan.asset
    /**
     * THE HEARTBEAT (POD-2101, spec §3.3). Same grant id, same `downloading`
     * state, new numbers — so a server that predates this reads each one as the
     * phase report it already understood, and one that does not sees the
     * download move.
     *
     * A SUPERSEDED GRANT GOES QUIET. Delivery cancellation is best-effort (git
     * steps finish what they started), and a report from a grant the server has
     * replaced would refresh the liveness of a convergence nobody is waiting
     * for.
     */
    const artifact = await deps.fetchArtifact(asset, plan.delivery, signal, (progress) => {
      if (signal?.aborted) return
      report(deps, grant, 'downloading', current, undefined, progress)
    })
    // A superseded grant must not swap a binary or write a rollback marker: the
    // grant it would claim to be applying is no longer the one the server holds.
    if (signal?.aborted) return
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
    if (signal?.aborted) return
    report(deps, grant, 'rejected', current, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Serialize grant application for one daemon.
 *
 * Grants can overlap — the server ages a silent grant into `stuck` and the
 * operator applies again, or a wave re-grants after a reconnect. Two concurrent
 * applications would race to swap the binary and each write its own rollback
 * marker. This keeps exactly one: a repeat of the SAME grant is ignored, and a
 * NEWER grant cancels the one in flight before taking over.
 *
 * "Cancels" is bounded by what the delivery can honour — a network download
 * aborts, and since POD-2046 so do the git steps, which are awaited rather than
 * blocking — but the superseded run is always AWAITED before the new one
 * starts, so two applications can never swap a binary or write a rollback
 * marker concurrently.
 */
export function createGrantRunner(deps: GrantApplyDeps): {
  apply(grant: UpdateGrantMessage): Promise<void>
} {
  let active: { grantId: string; abort: AbortController; done: Promise<void> } | null = null

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
