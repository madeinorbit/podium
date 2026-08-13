import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MachineId } from '@podium/model'
import type {
  ShippingJobClassification,
  ShippingJobRequestMessage,
  ShippingJobResult,
} from '@podium/protocol'
import { ShippingJobJournal } from './journal'

type Request = ShippingJobRequestMessage
type Result = ShippingJobResult

const GIT_TIMEOUT_MS = 30_000

interface Observation {
  sourceSha?: string
  targetSha?: string
  dirty?: boolean
  sourceContainsBase?: boolean
  sourceInTarget?: boolean
  error?: string
}

function git(repoPath: string, argv: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

function observe(request: Request): Observation {
  try {
    git(request.repoPath, ['check-ref-format', '--branch', request.sourceBranch])
    git(request.repoPath, ['check-ref-format', '--branch', request.targetBranch])
    const sourceSha = git(request.repoPath, ['rev-parse', `refs/heads/${request.sourceBranch}`])
    const targetSha = git(request.repoPath, ['rev-parse', `refs/heads/${request.targetBranch}`])
    return {
      sourceSha,
      targetSha,
      dirty: git(request.repoPath, ['status', '--porcelain=v1', '--untracked-files=all']) !== '',
      sourceContainsBase: isAncestor(request.repoPath, request.approvedBaseSha, sourceSha),
      sourceInTarget: isAncestor(request.repoPath, sourceSha, targetSha),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function classifyFence(
  request: Request,
  observation: Observation,
): ShippingJobClassification | null {
  if (observation.error) return 'invalid-request'
  if (observation.sourceSha !== request.approvedHeadSha || !observation.sourceContainsBase) {
    return 'source-moved'
  }
  if (observation.targetSha !== request.expectedTargetSha) return 'target-moved'
  if (observation.dirty) return 'dirty-worktree'
  return null
}

function localDestinationMatches(request: Request): boolean {
  return (
    request.destination === request.targetBranch ||
    request.destination === `local:${request.targetBranch}` ||
    request.destination === `refs/heads/${request.targetBranch}`
  )
}

/** Fixed-operation compatibility executor. It can observe and prove, but the
 * first unsupported destination mutation becomes a hold before any ref effect. */
export class ShippingExecutionPlane {
  readonly journal: ShippingJobJournal

  constructor(
    dir: string,
    private readonly machineId: MachineId,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.journal = new ShippingJobJournal(join(dir, 'jobs'))
  }

  handle(request: Request): Result {
    const latestGeneration = this.journal.latestGeneration(request.orderId)
    if (latestGeneration !== null && latestGeneration > request.generation) {
      return this.transient(
        request,
        'held',
        'stale-generation',
        'stale shipping generation refused',
      )
    }
    if (request.action === 'status') return this.status(request)
    if (request.action === 'cancel') return this.cancel(request)

    const existing = this.journal.get(request.jobId)
    if (existing && existing.request.generation > request.generation) {
      return this.transient(
        request,
        'held',
        'stale-generation',
        'stale shipping generation refused',
      )
    }
    const started = this.journal.begin(
      request,
      this.base(request, 'running', 'observed', 'shipping job started'),
    )
    if (started.result.state !== 'running') return started.result

    const observation = observe(request)
    const fenced = classifyFence(request, observation)
    let terminal: Result
    if (fenced) {
      terminal = this.resultFromObservation(request, observation, 'held', fenced, fenced)
    } else if (request.operation === 'preflight') {
      terminal = this.resultFromObservation(
        request,
        observation,
        'succeeded',
        'observed',
        'approved source and target fences match',
      )
    } else if (!localDestinationMatches(request)) {
      terminal = this.resultFromObservation(
        request,
        observation,
        'held',
        'unsupported-destination-effect',
        'compatibility executor cannot mutate or prove this destination',
      )
    } else if (observation.sourceInTarget) {
      terminal = this.resultFromObservation(
        request,
        observation,
        'succeeded',
        'proved',
        'approved source is already contained by the configured destination',
      )
    } else {
      terminal = this.resultFromObservation(
        request,
        observation,
        'held',
        request.operation === 'verify' ? 'destination-mismatch' : 'unsupported-destination-effect',
        request.operation === 'verify'
          ? 'configured destination does not contain the approved source'
          : 'safe compatibility mode stopped before an unsupported ref mutation',
      )
    }
    return this.journal.update(request.jobId, request.generation, terminal).result
  }

  private status(request: Request): Result {
    const entry = this.journal.get(request.jobId)
    if (!entry) return this.transient(request, 'held', 'invalid-request', 'unknown shipping job')
    if (entry.request.generation !== request.generation) {
      return this.transient(
        request,
        'held',
        'stale-generation',
        'shipping status generation mismatch',
      )
    }
    return entry.result
  }

  private cancel(request: Request): Result {
    const entry = this.journal.get(request.jobId)
    if (!entry) return this.transient(request, 'cancelled', 'cancelled', 'shipping job absent')
    if (entry.request.generation !== request.generation) {
      return this.transient(
        request,
        'held',
        'stale-generation',
        'shipping cancel generation mismatch',
      )
    }
    if (entry.result.state !== 'running') return entry.result
    return this.journal.update(
      request.jobId,
      request.generation,
      this.base(request, 'cancelled', 'cancelled', 'shipping job cancelled'),
    ).result
  }

  private transient(
    request: Request,
    state: Result['state'],
    classification: Result['classification'],
    summary: string,
  ): Result {
    return this.base(request, state, classification, summary)
  }

  private base(
    request: Request,
    state: Result['state'],
    classification: Result['classification'],
    summary: string,
  ): Result {
    const at = this.now()
    return {
      jobId: request.jobId,
      orderId: request.orderId,
      attemptId: request.attemptId,
      machineId: this.machineId,
      generation: request.generation,
      operation: request.operation,
      state,
      classification,
      summary,
      logs: [summary],
      artifactRefs: [],
      heartbeatedAt: at,
      ...(state === 'running' ? {} : { finishedAt: at }),
    }
  }

  private resultFromObservation(
    request: Request,
    observation: Observation,
    state: Extract<Result['state'], 'succeeded' | 'held'>,
    classification: Result['classification'],
    summary: string,
  ): Result {
    return {
      ...this.base(request, state, classification, summary),
      ...(observation.sourceSha ? { observedSourceSha: observation.sourceSha } : {}),
      ...(observation.targetSha ? { observedTargetSha: observation.targetSha } : {}),
      ...(state === 'succeeded' && request.operation !== 'preflight' && observation.targetSha
        ? { observedDestinationSha: observation.targetSha }
        : {}),
      logs: [
        summary,
        ...(observation.error ? [observation.error] : []),
        ...(observation.sourceSha ? [`source ${observation.sourceSha}`] : []),
        ...(observation.targetSha ? [`target ${observation.targetSha}`] : []),
      ],
    }
  }
}
