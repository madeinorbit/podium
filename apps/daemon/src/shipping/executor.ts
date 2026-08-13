import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { MachineId } from '@podium/model'
import type { ShippingJobClassification, ShippingJobRequestMessage, ShippingJobResult } from '@podium/protocol/daemon'
import { shippingJobRequestFingerprint } from '@podium/protocol/daemon'
import { ShippingJobJournal, type ShippingJournalCrashPoint } from './journal'

type Request = ShippingJobRequestMessage
type Result = ShippingJobResult

const GIT_TIMEOUT_MS = 30_000
const ZERO_SHA = '0000000000000000000000000000000000000000'
const MAX_OUTPUT_BYTES = 256 * 1024

interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
}

interface Worktree {
  path: string
  head: string
  branch?: string
}

export type ShippingExecutionCrashPoint =
  | 'after-shipping-root-parent-fsync'
  | ShippingJournalCrashPoint

export interface ShippingProviderContext {
  request: Request
  repoPath: string
  testedIntegrationSha: string
  landedRefSha: string
}

export interface ShippingProviderProof {
  landedRefSha: string
  destinationSha?: string
  logs?: string[]
}

/** Provider publication is an injected capability. Built-ins cover a local ref
 * and an ordinary non-force git remote; hosted merge queues plug in here and
 * may truthfully report a provider-rewritten landed ref. */
export interface ShippingProviderAdapter {
  readonly id: string
  matches(request: Request): boolean
  publish(context: ShippingProviderContext): ShippingProviderProof
  verify(context: ShippingProviderContext): ShippingProviderProof
}

function run(
  file: string,
  argv: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): CommandResult {
  const result = spawnSync(file, argv, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return {
    ok: result.status === 0 && !result.error,
    stdout: (result.stdout ?? '').trim(),
    stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim(),
    status: result.status,
  }
}

function gitResult(repoPath: string, argv: string[], timeoutMs = GIT_TIMEOUT_MS): CommandResult {
  return run('git', ['-C', repoPath, ...argv], { timeoutMs })
}

function git(repoPath: string, argv: string[]): string {
  const result = gitResult(repoPath, argv)
  if (!result.ok) throw new Error(result.stderr || result.stdout || `git ${argv[0]} failed`)
  return result.stdout
}

function refTip(repoPath: string, ref: string): string | null {
  const result = gitResult(repoPath, ['rev-parse', '--verify', ref])
  return result.ok && result.stdout ? result.stdout.split(/\s+/)[0]! : null
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  return gitResult(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]).ok
}

function worktrees(repoPath: string): Worktree[] {
  const output = git(repoPath, ['worktree', 'list', '--porcelain'])
  return output
    .split(/\n\n+/)
    .map((block) => {
      const fields = new Map<string, string>()
      for (const line of block.split('\n').filter(Boolean)) {
        const split = line.indexOf(' ')
        fields.set(split < 0 ? line : line.slice(0, split), split < 0 ? '' : line.slice(split + 1))
      }
      return {
        path: fields.get('worktree') ?? '',
        head: fields.get('HEAD') ?? '',
        branch: fields.get('branch'),
      }
    })
    .filter((entry) => entry.path && entry.head)
}

function clean(path: string): boolean {
  return git(path, ['status', '--porcelain=v1', '--untracked-files=all']) === ''
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ref'
}

function destinationBranch(destination: string): { remote: string; branch: string } | null {
  const match = /^(?:remote|git):([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)$/.exec(destination)
  if (!match || match[2]!.startsWith('-')) return null
  return { remote: match[1]!, branch: match[2]! }
}

function validRemoteDestination(
  repoPath: string,
  destination: { remote: string; branch: string },
): boolean {
  if (!gitResult(repoPath, ['check-ref-format', '--branch', destination.branch]).ok) return false
  const remotes = gitResult(repoPath, ['remote'])
  return remotes.ok && remotes.stdout.split('\n').includes(destination.remote)
}

function localDestinationMatches(request: Request): boolean {
  return (
    request.destination === request.targetBranch ||
    request.destination === `local:${request.targetBranch}` ||
    request.destination === `refs/heads/${request.targetBranch}`
  )
}

class LocalRefProvider implements ShippingProviderAdapter {
  readonly id = 'local-ref'
  matches(request: Request): boolean {
    return localDestinationMatches(request)
  }
  publish(context: ShippingProviderContext): ShippingProviderProof {
    const tip = refTip(context.repoPath, `refs/heads/${context.request.targetBranch}`)
    if (tip !== context.landedRefSha) throw new Error('local target no longer names the landed ref')
    return {
      landedRefSha: context.landedRefSha,
      destinationSha: tip,
      logs: ['local target needs no outward publication'],
    }
  }
  verify(context: ShippingProviderContext): ShippingProviderProof {
    return this.publish(context)
  }
}

class GitRemoteProvider implements ShippingProviderAdapter {
  readonly id = 'git-remote'
  matches(request: Request): boolean {
    return destinationBranch(request.destination) !== null
  }
  publish(context: ShippingProviderContext): ShippingProviderProof {
    const destination = destinationBranch(context.request.destination)
    if (!destination || !validRemoteDestination(context.repoPath, destination)) {
      throw new Error('invalid or unconfigured git remote destination')
    }
    const pushed = gitResult(context.repoPath, [
      'push',
      '--porcelain',
      '--',
      destination.remote,
      `${context.landedRefSha}:refs/heads/${destination.branch}`,
    ])
    if (!pushed.ok) throw new Error(pushed.stderr || pushed.stdout || 'non-force push rejected')
    return {
      landedRefSha: context.landedRefSha,
      logs: [pushed.stdout || 'remote accepted exact landed ref'],
    }
  }
  verify(context: ShippingProviderContext): ShippingProviderProof {
    const destination = destinationBranch(context.request.destination)
    if (!destination || !validRemoteDestination(context.repoPath, destination)) {
      throw new Error('invalid or unconfigured git remote destination')
    }
    const observed = gitResult(context.repoPath, [
      'ls-remote',
      '--refs',
      '--',
      destination.remote,
      `refs/heads/${destination.branch}`,
    ])
    if (!observed.ok) throw new Error(observed.stderr || 'could not read configured destination')
    const destinationSha = observed.stdout.split(/\s+/)[0]
    if (!destinationSha || destinationSha !== context.landedRefSha) {
      throw new Error(
        `configured destination is ${destinationSha || 'absent'}, expected ${context.landedRefSha}`,
      )
    }
    return {
      landedRefSha: context.landedRefSha,
      destinationSha,
      logs: [`verified ${destination.remote}/${destination.branch}`],
    }
  }
}

/** Exact, restart-safe single-order landing executor. Every irreversible
 * boundary is preceded by immutable journal input and followed by observation;
 * replay therefore finishes a partial effect or returns the same proof. */
export class ShippingExecutionPlane {
  readonly journal: ShippingJobJournal
  private readonly checkoutsDir: string
  private readonly integrationDir: string
  private readonly logsDir: string
  private readonly providers: readonly ShippingProviderAdapter[]

  constructor(
    private readonly dir: string,
    private readonly machineId: MachineId,
    private readonly now: () => string = () => new Date().toISOString(),
    providers: readonly ShippingProviderAdapter[] = [
      new LocalRefProvider(),
      new GitRemoteProvider(),
    ],
    crashPoint?: (point: ShippingExecutionCrashPoint) => void,
  ) {
    const existed = existsSync(dir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!existed) {
      const parent = openSync(dirname(dir), 'r')
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
      crashPoint?.('after-shipping-root-parent-fsync')
    }
    this.journal = new ShippingJobJournal(join(dir, 'jobs'), (point) => crashPoint?.(point))
    this.checkoutsDir = join(dir, 'landing-checkouts')
    this.integrationDir = join(dir, 'integration-checkouts')
    this.logsDir = join(dir, 'logs')
    for (const path of [this.checkoutsDir, this.integrationDir, this.logsDir]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    this.providers = providers
  }

  handle(request: Request): Result {
    if (this.requestDigest(request) !== request.requestDigest) {
      return this.base(request, 'held', 'invalid-request', 'shipping request digest mismatch')
    }
    let latestGeneration: number | null
    try {
      latestGeneration = this.journal.latestGeneration(request.orderId)
    } catch (error) {
      return this.base(
        request,
        'held',
        'invalid-request',
        `shipping journal is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (latestGeneration !== null && latestGeneration > request.generation) {
      return this.base(request, 'held', 'stale-generation', 'stale shipping generation refused')
    }
    if (request.action === 'status') return this.status(request)
    if (request.action === 'cancel') return this.cancel(request)
    if (request.action === 'acknowledge') return this.acknowledge(request)

    const existing = this.journal.get(request.jobId)
    if (existing && existing.request.generation > request.generation) {
      return this.base(request, 'held', 'stale-generation', 'stale shipping generation refused')
    }
    let started
    try {
      started = this.journal.begin(
        request,
        this.base(request, 'running', 'observed', 'shipping effect started'),
      )
    } catch (error) {
      return this.base(
        request,
        'held',
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (started.result.state !== 'running') return started.result

    let terminal: Result
    try {
      terminal = this.execute(request)
    } catch (error) {
      terminal = this.base(
        request,
        'held',
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
    return this.journal.update(request.jobId, request.generation, terminal).result
  }

  private execute(request: Request): Result {
    if (request.validationProfile.id !== request.validationProfile.id.trim()) {
      return this.base(request, 'held', 'invalid-request', 'validation profile id is not canonical')
    }
    if (request.sourceBranch.startsWith('-') || request.targetBranch.startsWith('-')) {
      return this.base(
        request,
        'held',
        'invalid-request',
        'source and target branches may not be option-like',
      )
    }
    git(request.repoPath, ['check-ref-format', '--branch', request.sourceBranch])
    git(request.repoPath, ['check-ref-format', '--branch', request.targetBranch])
    if (request.operation === 'preflight') return this.preflight(request)
    if (request.operation === 'prepare-merge-group') return this.prepare(request)
    if (request.operation === 'validate') return this.validate(request)
    if (request.operation === 'commit-merge-group') return this.commit(request)
    if (request.operation === 'publish') return this.publish(request)
    return this.verify(request)
  }

  private requestDigest(request: Request): string {
    const {
      type: _type,
      requestId: _requestId,
      action: _action,
      requestDigest: _digest,
      ...facts
    } = request
    return createHash('sha256').update(shippingJobRequestFingerprint(facts)).digest('hex')
  }

  private sourceAndTarget(request: Request): {
    sourceSha: string | null
    targetSha: string | null
  } {
    return {
      sourceSha: refTip(request.repoPath, `refs/heads/${request.sourceBranch}`),
      targetSha: refTip(request.repoPath, `refs/heads/${request.targetBranch}`),
    }
  }

  private fence(request: Request): Result | null {
    const { sourceSha, targetSha } = this.sourceAndTarget(request)
    if (
      sourceSha !== request.approvedHeadSha ||
      !isAncestor(request.repoPath, request.approvedBaseSha, sourceSha ?? '')
    ) {
      return this.observed(
        request,
        'held',
        'source-moved',
        'approved source fence changed',
        sourceSha,
        targetSha,
      )
    }
    if (targetSha !== request.expectedTargetSha) {
      return this.observed(
        request,
        'held',
        'target-moved',
        'target fence changed',
        sourceSha,
        targetSha,
      )
    }
    return null
  }

  private preflight(request: Request): Result {
    const fenced = this.fence(request)
    if (fenced) return fenced
    const sourceOwner = worktrees(request.repoPath).find(
      (entry) => entry.branch === `refs/heads/${request.sourceBranch}`,
    )
    if (sourceOwner && !clean(sourceOwner.path)) {
      return this.observed(
        request,
        'held',
        'dirty-worktree',
        `source worktree is dirty: ${sourceOwner.path}`,
      )
    }
    const remote = destinationBranch(request.destination)
    if (remote && !validRemoteDestination(request.repoPath, remote)) {
      return this.observed(
        request,
        'held',
        'unsupported-destination-effect',
        'git destination must name a configured remote and canonical branch',
      )
    }
    const landing = this.ensureLandingCheckout(request)
    if ('classification' in landing) return landing
    if (!this.provider(request)) {
      return this.observed(
        request,
        'held',
        'unsupported-destination-effect',
        `no provider adapter accepts ${request.destination}`,
      )
    }
    return this.observed(
      request,
      'succeeded',
      'observed',
      `landing checkout ready at ${landing.path}`,
    )
  }

  private prepare(request: Request): Result {
    const fenced = this.fence(request)
    if (fenced) return fenced
    if (!isAncestor(request.repoPath, request.expectedTargetSha, request.approvedHeadSha)) {
      return this.observed(
        request,
        'held',
        'merge-conflict',
        'approved source is not a fast-forward of the frozen target',
      )
    }
    const candidate = request.approvedHeadSha
    const shadow = this.shadowRef(request)
    const existing = refTip(request.repoPath, shadow)
    if (existing && existing !== candidate) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        `immutable shadow ref ${shadow} already names ${existing}`,
      )
    }
    if (!existing) {
      const created = gitResult(request.repoPath, ['update-ref', shadow, candidate, ZERO_SHA])
      if (!created.ok)
        return this.observed(
          request,
          'held',
          'target-moved',
          created.stderr || 'shadow ref creation raced',
        )
    }
    const integration = this.ensureIntegrationCheckout(request, candidate)
    if ('classification' in integration) return integration
    return {
      ...this.observed(
        request,
        'succeeded',
        'observed',
        `immutable merge group prepared at ${candidate}`,
      ),
      testedIntegrationSha: candidate,
      logs: [`shadow ${shadow} ${candidate}`, `integration checkout ${integration.path}`],
    }
  }

  private validate(request: Request): Result {
    const fenced = this.fence(request)
    if (fenced) return fenced
    const candidate = refTip(request.repoPath, this.shadowRef(request))
    if (!candidate)
      return this.observed(request, 'held', 'invalid-request', 'merge-group shadow ref is absent')
    const integration = this.ensureIntegrationCheckout(request, candidate)
    if ('classification' in integration) return integration
    const [file, ...argv] = request.validationProfile.argv
    const validation = run(file!, argv, {
      cwd: integration.path,
      timeoutMs: request.validationProfile.timeoutMs,
    })
    const logPath = join(
      this.logsDir,
      `${createHash('sha256').update(request.jobId).digest('hex')}.log`,
    )
    writeFileSync(
      logPath,
      [`$ ${request.validationProfile.argv.join(' ')}`, validation.stdout, validation.stderr]
        .filter(Boolean)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
    const passed = validation.ok
    return {
      ...this.observed(
        request,
        passed ? 'succeeded' : 'held',
        passed ? 'proved' : 'validation-failed',
        passed
          ? `validation profile ${request.validationProfile.id} passed for ${candidate}`
          : `validation profile ${request.validationProfile.id} failed for ${candidate}`,
      ),
      testedIntegrationSha: candidate,
      validationProfileId: request.validationProfile.id,
      validationResult: passed ? 'passed' : 'failed',
      artifactRefs: [logPath],
      logs: [
        `profile ${request.validationProfile.id}`,
        `candidate ${candidate}`,
        ...(validation.stdout ? [validation.stdout] : []),
        ...(validation.stderr ? [validation.stderr] : []),
      ],
    }
  }

  private commit(request: Request): Result {
    const candidate = refTip(request.repoPath, this.shadowRef(request))
    if (!candidate)
      return this.observed(request, 'held', 'invalid-request', 'merge-group shadow ref is absent')
    const validation = this.proof(request, 'validate')
    if (
      validation?.state !== 'succeeded' ||
      validation.testedIntegrationSha !== candidate ||
      validation.validationProfileId !== request.validationProfile.id ||
      validation.validationResult !== 'passed'
    ) {
      return this.observed(
        request,
        'held',
        'validation-failed',
        'candidate has no matching green validation proof',
      )
    }
    const { sourceSha, targetSha } = this.sourceAndTarget(request)
    if (sourceSha !== request.approvedHeadSha && sourceSha !== candidate) {
      return this.observed(
        request,
        'held',
        'source-moved',
        'source compare-and-swap fence changed',
        sourceSha,
        targetSha,
      )
    }
    if (targetSha !== request.expectedTargetSha && targetSha !== candidate) {
      return this.observed(
        request,
        'held',
        'target-moved',
        'target compare-and-swap fence changed',
        sourceSha,
        targetSha,
      )
    }
    const landing = this.ensureLandingCheckout(request)
    if ('classification' in landing) return landing

    // A composed candidate may rewrite the source prefix. Single-order fast-forward
    // candidates normally equal approvedHeadSha; this CAS makes the recovery rule
    // explicit without ever moving the source before validation.
    if (sourceSha === request.approvedHeadSha && candidate !== request.approvedHeadSha) {
      const moved = gitResult(request.repoPath, [
        'update-ref',
        `refs/heads/${request.sourceBranch}`,
        candidate,
        request.approvedHeadSha,
      ])
      if (!moved.ok)
        return this.observed(request, 'held', 'source-moved', moved.stderr || 'source CAS failed')
    }
    if (targetSha === request.expectedTargetSha) {
      if (refTip(landing.path, 'HEAD') !== request.expectedTargetSha || !clean(landing.path)) {
        return this.observed(
          request,
          'held',
          'wrong-target-checkout',
          'landing checkout is not at the expected target',
        )
      }
      const detached = gitResult(landing.path, ['checkout', '--detach', request.expectedTargetSha])
      if (!detached.ok) {
        return this.observed(
          request,
          'held',
          'wrong-target-checkout',
          detached.stderr || 'could not detach landing checkout',
        )
      }
      const moved = gitResult(request.repoPath, [
        'update-ref',
        `refs/heads/${request.targetBranch}`,
        candidate,
        request.expectedTargetSha,
      ])
      if (!moved.ok) {
        gitResult(landing.path, ['checkout', request.targetBranch])
        return this.observed(
          request,
          'held',
          'target-moved',
          moved.stderr || 'target compare-and-swap failed',
        )
      }
    }
    const landingEntry = worktrees(request.repoPath).find((entry) => entry.path === landing.path)
    if (
      refTip(landing.path, 'HEAD') !== candidate ||
      landingEntry?.branch !== `refs/heads/${request.targetBranch}`
    ) {
      const attached = gitResult(landing.path, ['checkout', request.targetBranch])
      if (!attached.ok) {
        return this.observed(
          request,
          'held',
          'wrong-target-checkout',
          attached.stderr || 'could not attach landing checkout',
        )
      }
    }
    const landed = refTip(request.repoPath, `refs/heads/${request.targetBranch}`)
    if (
      landed !== candidate ||
      refTip(landing.path, 'HEAD') !== candidate ||
      !clean(landing.path)
    ) {
      return this.observed(
        request,
        'held',
        'wrong-target-checkout',
        'landing checkout did not converge on the exact tested candidate',
      )
    }
    return {
      ...this.observed(
        request,
        'succeeded',
        'proved',
        `target now names exact tested candidate ${candidate}`,
      ),
      testedIntegrationSha: candidate,
      landedRefSha: candidate,
      validationProfileId: request.validationProfile.id,
      validationResult: 'passed',
    }
  }

  private publish(request: Request): Result {
    const context = this.providerContext(request, false)
    if ('classification' in context) return context
    const adapter = this.provider(request)
    if (!adapter)
      return this.observed(
        request,
        'held',
        'unsupported-destination-effect',
        `no provider adapter accepts ${request.destination}`,
      )
    try {
      const proof = adapter.publish(context)
      return {
        ...this.observed(request, 'succeeded', 'proved', `published through ${adapter.id}`),
        testedIntegrationSha: context.testedIntegrationSha,
        landedRefSha: proof.landedRefSha,
        ...(proof.destinationSha ? { observedDestinationSha: proof.destinationSha } : {}),
        validationProfileId: request.validationProfile.id,
        validationResult: 'passed',
        logs: proof.logs ?? [`provider ${adapter.id} accepted publication`],
      }
    } catch (error) {
      return this.observed(
        request,
        'held',
        'publish-rejected',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private verify(request: Request): Result {
    const context = this.providerContext(request, true)
    if ('classification' in context) return context
    const adapter = this.provider(request)
    if (!adapter)
      return this.observed(
        request,
        'held',
        'unsupported-destination-effect',
        `no provider adapter accepts ${request.destination}`,
      )
    try {
      const proof = adapter.verify(context)
      if (!proof.destinationSha)
        throw new Error('provider returned no configured-destination proof')
      return {
        ...this.observed(
          request,
          'succeeded',
          'proved',
          `configured destination proved by ${adapter.id}`,
        ),
        testedIntegrationSha: context.testedIntegrationSha,
        landedRefSha: proof.landedRefSha,
        observedDestinationSha: proof.destinationSha,
        validationProfileId: request.validationProfile.id,
        validationResult: 'passed',
        logs: proof.logs ?? [`provider ${adapter.id} proved destination ${proof.destinationSha}`],
      }
    } catch (error) {
      return this.observed(
        request,
        'held',
        'destination-mismatch',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private providerContext(
    request: Request,
    requirePublished: boolean,
  ): ShippingProviderContext | Result {
    const validation = this.proof(request, 'validate')
    const committed = this.proof(request, 'commit-merge-group')
    const published = requirePublished ? this.proof(request, 'publish') : null
    if (
      validation?.state !== 'succeeded' ||
      validation.validationResult !== 'passed' ||
      !validation.testedIntegrationSha ||
      committed?.state !== 'succeeded' ||
      committed.testedIntegrationSha !== validation.testedIntegrationSha ||
      !committed.landedRefSha ||
      (requirePublished &&
        (published?.state !== 'succeeded' || published.landedRefSha !== committed.landedRefSha))
    ) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'publication proof chain is incomplete',
      )
    }
    return {
      request,
      repoPath: request.repoPath,
      testedIntegrationSha: validation.testedIntegrationSha,
      landedRefSha: committed.landedRefSha,
    }
  }

  private provider(request: Request): ShippingProviderAdapter | undefined {
    return this.providers.find((adapter) => adapter.matches(request))
  }

  private proof(request: Request, operation: Request['operation']): Result | null {
    const entry = this.journal
      .list()
      .filter(
        (candidate) =>
          candidate.request.jobId === `${request.attemptId}:${operation}` &&
          candidate.request.orderId === request.orderId &&
          candidate.request.attemptId === request.attemptId &&
          candidate.request.generation === request.generation &&
          candidate.request.operation === operation &&
          candidate.request.repoPath === request.repoPath &&
          candidate.request.sourceBranch === request.sourceBranch &&
          candidate.request.targetBranch === request.targetBranch &&
          candidate.request.approvedBaseSha === request.approvedBaseSha &&
          candidate.request.approvedHeadSha === request.approvedHeadSha &&
          candidate.request.expectedTargetSha === request.expectedTargetSha &&
          candidate.request.destination === request.destination &&
          JSON.stringify(candidate.request.validationProfile) ===
            JSON.stringify(request.validationProfile) &&
          JSON.stringify(candidate.request.providerRef ?? null) ===
            JSON.stringify(request.providerRef ?? null),
      )
      .at(-1)
    if (!entry) return null
    const { requestDigest, ...facts } = entry.request
    const digest = createHash('sha256').update(shippingJobRequestFingerprint(facts)).digest('hex')
    return digest === requestDigest &&
      entry.result.jobId === entry.request.jobId &&
      entry.result.requestDigest === requestDigest &&
      entry.result.orderId === entry.request.orderId &&
      entry.result.attemptId === entry.request.attemptId &&
      entry.result.generation === entry.request.generation &&
      entry.result.operation === entry.request.operation
      ? entry.result
      : null
  }

  private ensureLandingCheckout(request: Request): { path: string } | Result {
    const repoKey = createHash('sha256')
      .update(realpathSync(request.repoPath))
      .digest('hex')
      .slice(0, 16)
    const desired = join(this.checkoutsDir, repoKey, safePart(request.targetBranch))
    const owner = worktrees(request.repoPath).find(
      (entry) => entry.branch === `refs/heads/${request.targetBranch}`,
    )
    if (owner) {
      if (!clean(owner.path)) {
        return this.observed(
          request,
          'held',
          'dirty-worktree',
          `target checkout is dirty: ${owner.path}`,
        )
      }
      // Safely adopt an already dedicated checkout, or use the repository's
      // existing clean target checkout as guarded compatibility mode.
      if (owner.path !== desired && realpathSync(owner.path) !== realpathSync(request.repoPath)) {
        return this.observed(
          request,
          'held',
          'wrong-target-checkout',
          `target is owned by another checkout: ${owner.path}`,
        )
      }
      return { path: owner.path }
    }
    const registeredDesired = worktrees(request.repoPath).find((entry) => entry.path === desired)
    if (registeredDesired) {
      if (!clean(desired)) {
        return this.observed(
          request,
          'held',
          'dirty-worktree',
          `landing checkout is dirty: ${desired}`,
        )
      }
      return { path: desired }
    }
    const current = this.journal.get(request.jobId)
    const repositoryRoot = worktrees(request.repoPath).find(
      (entry) => realpathSync(entry.path) === realpathSync(request.repoPath),
    )
    if (
      request.operation === 'commit-merge-group' &&
      current?.result.state === 'running' &&
      repositoryRoot &&
      !repositoryRoot.branch &&
      repositoryRoot.head === request.expectedTargetSha &&
      clean(repositoryRoot.path)
    ) {
      // The executor may have died after detaching a clean compatibility
      // checkout but before/after the target CAS. The durable running record is
      // the authority to finish that exact transition and reattach it.
      return { path: repositoryRoot.path }
    }
    if (existsSync(desired)) {
      return this.observed(
        request,
        'held',
        'wrong-target-checkout',
        `landing path exists but is not an adopted git worktree: ${desired}`,
      )
    }
    mkdirSync(dirname(desired), { recursive: true, mode: 0o700 })
    const added = gitResult(request.repoPath, [
      'worktree',
      'add',
      '--',
      desired,
      request.targetBranch,
    ])
    if (!added.ok) {
      return this.observed(
        request,
        'held',
        'wrong-target-checkout',
        added.stderr || added.stdout || 'could not create landing checkout',
      )
    }
    return { path: desired }
  }

  private ensureIntegrationCheckout(
    request: Request,
    candidate: string,
  ): { path: string } | Result {
    const path = join(this.integrationDir, `${safePart(request.orderId)}-${request.generation}`)
    const existing = worktrees(request.repoPath).find((entry) => entry.path === path)
    if (existing) {
      if (existing.head !== candidate || existing.branch || !clean(path)) {
        return this.observed(
          request,
          'held',
          'dirty-worktree',
          `integration checkout is not the immutable candidate: ${path}`,
        )
      }
      return { path }
    }
    if (existsSync(path)) {
      return this.observed(
        request,
        'held',
        'dirty-worktree',
        `integration path exists outside git custody: ${path}`,
      )
    }
    const added = gitResult(request.repoPath, [
      'worktree',
      'add',
      '--detach',
      '--',
      path,
      candidate,
    ])
    if (!added.ok)
      return this.observed(
        request,
        'held',
        'invalid-request',
        added.stderr || added.stdout || 'could not create integration checkout',
      )
    return { path }
  }

  private shadowRef(request: Request): string {
    return `refs/podium/ship/${safePart(request.orderId)}/${request.generation}/candidate`
  }

  private status(request: Request): Result {
    let entry: ReturnType<ShippingJobJournal['get']>
    try {
      entry = this.journal.get(request.jobId)
    } catch (error) {
      return this.base(
        request,
        'held',
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!entry) return this.base(request, 'held', 'invalid-request', 'unknown shipping job')
    if (!this.matchesJournalRequest(request, entry.request)) {
      return this.base(request, 'held', 'invalid-request', 'shipping status input collision')
    }
    if (entry.request.generation !== request.generation) {
      return this.base(request, 'held', 'stale-generation', 'shipping status generation mismatch')
    }
    return entry.result
  }

  private cancel(request: Request): Result {
    let entry: ReturnType<ShippingJobJournal['get']>
    try {
      entry = this.journal.get(request.jobId)
    } catch (error) {
      return this.base(
        request,
        'held',
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!entry) return this.base(request, 'cancelled', 'cancelled', 'shipping job absent')
    if (!this.matchesJournalRequest(request, entry.request)) {
      return this.base(request, 'held', 'invalid-request', 'shipping cancellation input collision')
    }
    if (entry.request.generation !== request.generation) {
      return this.base(request, 'held', 'stale-generation', 'shipping cancel generation mismatch')
    }
    if (entry.result.state !== 'running') return entry.result
    return this.journal.update(
      request.jobId,
      request.generation,
      this.base(request, 'cancelled', 'cancelled', 'shipping job cancelled'),
    ).result
  }

  private acknowledge(request: Request): Result {
    let entry: ReturnType<ShippingJobJournal['get']>
    try {
      entry = this.journal.get(request.jobId)
    } catch (error) {
      return this.base(
        request,
        'held',
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!entry) return this.base(request, 'held', 'invalid-request', 'unknown shipping job')
    if (!this.matchesJournalRequest(request, entry.request)) {
      return this.base(
        request,
        'held',
        'invalid-request',
        'shipping acknowledgement input collision',
      )
    }
    if (entry.request.generation !== request.generation) {
      return this.base(
        request,
        'held',
        'stale-generation',
        'shipping acknowledgement generation mismatch',
      )
    }
    try {
      return this.journal.acknowledge(request.jobId, request.generation, this.now()).result
    } catch (error) {
      return this.base(
        request,
        'held',
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private matchesJournalRequest(
    request: Request,
    durable: Omit<Request, 'type' | 'requestId' | 'action'>,
  ): boolean {
    const { type: _type, requestId: _requestId, action: _action, ...facts } = request
    return JSON.stringify(facts) === JSON.stringify(durable)
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
      requestDigest: request.requestDigest,
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

  private observed(
    request: Request,
    state: Extract<Result['state'], 'succeeded' | 'held'>,
    classification: ShippingJobClassification,
    summary: string,
    sourceSha = refTip(request.repoPath, `refs/heads/${request.sourceBranch}`),
    targetSha = refTip(request.repoPath, `refs/heads/${request.targetBranch}`),
  ): Result {
    return {
      ...this.base(request, state, classification, summary),
      ...(sourceSha ? { observedSourceSha: sourceSha } : {}),
      ...(targetSha ? { observedTargetSha: targetSha } : {}),
    }
  }
}
