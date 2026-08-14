import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { shipRepairRef, type MachineId } from '@podium/model'
import type {
  ShippingJobClassification,
  ShippingJobRequestMessage,
  ShippingJobResult,
} from '@podium/protocol/daemon'
import {
  SHIPPING_TRAIN_CAPABILITY,
  shippingEvidenceFingerprint,
  shippingJobRequestFingerprint,
  shippingJobRequestMatchesTrain,
  shippingTrainProofsMatch,
  shippingTrainSubsetFingerprint,
} from '@podium/protocol/daemon'
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
  trainProofs?: NonNullable<Result['trainProofs']>
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
  options: { cwd?: string; timeoutMs?: number; input?: string } = {},
): CommandResult {
  const result = spawnSync(file, argv, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    const trainError = this.trainRequestError(request)
    if (trainError) return this.base(request, 'held', 'invalid-request', trainError)
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
    for (const member of this.trainMembers(request)) {
      if (member.sourceBranch.startsWith('-')) {
        return this.base(request, 'held', 'invalid-request', 'train source branch is option-like')
      }
      git(request.repoPath, ['check-ref-format', '--branch', member.sourceBranch])
    }
    if (request.operation === 'preflight') return this.preflight(request)
    if (request.operation === 'apply-repair') return this.applyRepair(request)
    if (request.operation === 'prepare-merge-group') return this.prepare(request)
    if (request.operation === 'validate') return this.validate(request)
    if (request.operation === 'commit-merge-group') return this.commit(request)
    if (request.operation === 'publish') return this.publish(request)
    return this.verify(request)
  }

  private applyRepair(request: Request): Result {
    const fenced = this.fence(request)
    if (fenced) return fenced
    const repair = request.repair
    if (!repair) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'repair application has no immutable candidate',
      )
    }
    if (
      repair.repairRef !==
      shipRepairRef(request.orderId, request.attemptId, request.generation, repair.contextDigest)
    ) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'repair ref does not match exact order, attempt, generation, and context custody',
      )
    }
    const validRef = gitResult(request.repoPath, ['check-ref-format', repair.repairRef])
    if (!validRef.ok)
      return this.observed(request, 'held', 'invalid-request', 'repair ref is invalid')
    const observed = refTip(request.repoPath, repair.repairRef)
    if (observed !== repair.candidateHeadSha) {
      return this.observed(request, 'held', 'source-moved', 'repair candidate ref moved')
    }
    const requiredHeads = this.trainMembers(request).map((member) => member.approvedHeadSha)
    if (requiredHeads.length === 0) requiredHeads.push(request.approvedHeadSha)
    if (
      !isAncestor(request.repoPath, request.expectedTargetSha, repair.candidateHeadSha) ||
      requiredHeads.some(
        (approvedHeadSha) =>
          !isAncestor(request.repoPath, approvedHeadSha, repair.candidateHeadSha),
      )
    ) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'repair candidate does not contain the frozen target and approved member heads',
      )
    }
    const immutableRef = `${this.executionRefBase(request)}/repair-input`
    const frozen = gitResult(request.repoPath, [
      'update-ref',
      immutableRef,
      repair.candidateHeadSha,
      ZERO_SHA,
    ])
    if (!frozen.ok && refTip(request.repoPath, immutableRef) !== repair.candidateHeadSha) {
      return this.observed(
        request,
        'held',
        'source-moved',
        frozen.stderr || 'repair candidate freeze raced',
      )
    }
    const members = this.trainMembers(request)
    const trainProofs = members.length > 0 ? this.freezeRepairMemberProofs(request, members) : null
    if (trainProofs && !Array.isArray(trainProofs)) return trainProofs
    return {
      ...this.observed(
        request,
        'succeeded',
        'proved',
        `repair round ${repair.round} candidate frozen`,
      ),
      testedIntegrationSha: repair.candidateHeadSha,
      ...(trainProofs ? { trainProofs } : {}),
      logs: [`repair ${repair.repairRef} ${repair.candidateHeadSha}`],
    }
  }

  private freezeRepairMemberProofs(
    request: Request,
    members: ReturnType<ShippingExecutionPlane['trainMembers']>,
  ): NonNullable<Result['trainProofs']> | Result {
    if (!request.repair || !request.train || !('manifest' in request.train)) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'repair member proof lacks v2 custody',
      )
    }
    const approvedTrain = {
      ...request.train,
      repairRound: 0,
      candidate: { kind: 'approved' as const },
    }
    approvedTrain.subsetId = `subset:${createHash('sha256')
      .update(shippingTrainSubsetFingerprint(approvedTrain))
      .digest('hex')}` as typeof approvedTrain.subsetId
    const approvedRequest: Request = {
      ...request,
      jobId: `${request.attemptId}:prepare-merge-group:${approvedTrain.subsetId}`,
      operation: 'prepare-merge-group',
      repair: undefined,
      train: approvedTrain,
      requestDigest: request.requestDigest,
    }
    const repairHead = request.repair.candidateHeadSha
    const proofs: NonNullable<Result['trainProofs']> = []
    let repaired = false
    for (const [ordinal, member] of members.entries()) {
      const approvedResult = refTip(
        request.repoPath,
        this.memberResultRef(approvedRequest, ordinal),
      )
      const mustUseRepair = !approvedResult || ordinal === members.length - 1
      const resultCommitSha = mustUseRepair ? repairHead : approvedResult
      if (
        !resultCommitSha ||
        !isAncestor(request.repoPath, member.approvedHeadSha, resultCommitSha) ||
        (ordinal > 0 &&
          !isAncestor(request.repoPath, proofs[ordinal - 1]!.resultCommitSha!, resultCommitSha))
      ) {
        return this.observed(
          request,
          'held',
          'invalid-request',
          `repair candidate cannot prove member ${member.orderId} in canonical order`,
        )
      }
      if (mustUseRepair) repaired = true
      const memberRef = this.memberResultRef(request, ordinal)
      const frozen = gitResult(request.repoPath, [
        'update-ref',
        memberRef,
        resultCommitSha,
        ZERO_SHA,
      ])
      if (!frozen.ok && refTip(request.repoPath, memberRef) !== resultCommitSha) {
        return this.observed(
          request,
          'held',
          'source-moved',
          frozen.stderr || `repair member ${member.orderId} proof raced`,
        )
      }
      proofs.push({
        issueId: member.issueId,
        orderId: member.orderId,
        attemptId: member.attemptId,
        generation: member.generation,
        sourceApprovedSha: member.approvedHeadSha,
        resultCommitSha,
      })
    }
    if (!repaired || proofs.at(-1)?.resultCommitSha !== repairHead) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'repair candidate is not the exact terminal member result',
      )
    }
    return proofs
  }

  private trainManifest(request: Request) {
    return request.train
      ? 'manifest' in request.train
        ? request.train.manifest
        : request.train
      : null
  }

  private trainMembers(request: Request) {
    const manifest = this.trainManifest(request)
    if (!manifest) return []
    if (!request.train || !('manifest' in request.train)) return manifest.members
    const byId = new Map(manifest.members.map((member) => [member.orderId, member] as const))
    return request.train.memberOrderIds.map((orderId) => byId.get(orderId)!)
  }

  private trainRequestError(request: Request): string | null {
    if (!request.train) return null
    if (!shippingJobRequestMatchesTrain(request)) return 'outer request contradicts train authority'
    const manifest = this.trainManifest(request)!
    if (!('manifest' in request.train)) {
      return manifest.members.length === 1 ? null : 'multi-member trains require shipping.train.v2'
    }
    if (request.train.capability !== SHIPPING_TRAIN_CAPABILITY) {
      return `unsupported shipping train capability ${request.train.capability}`
    }
    const subsetId = `subset:${createHash('sha256')
      .update(shippingTrainSubsetFingerprint(request.train))
      .digest('hex')}`
    if (request.train.subsetId !== subsetId) return 'shipping train subset identity mismatch'
    if (manifest.members.length > 1 && request.shippingProtocolVersion !== 2) {
      return 'multi-member trains require protocol v2'
    }
    return null
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

  private evidenceRef(request: Request, ordinal: number): `artifact://shipping/${string}` {
    return `artifact://shipping/${createHash('sha256')
      .update(shippingEvidenceFingerprint(request, this.machineId, ordinal))
      .digest('hex')}`
  }

  /** Resolve only the exact effect authority which minted the opaque ref. A
   * stale generation, another order/subset, or an invented ref cannot become a
   * native-path oracle. The caller must also authorize the order before serving
   * the returned file. */
  resolveEvidence(request: Request, artifactRef: string): string | null {
    if (request.requestDigest !== this.requestDigest(request)) return null
    if (artifactRef !== this.evidenceRef(request, 0)) return null
    let entry: ReturnType<ShippingJobJournal['get']>
    try {
      entry = this.journal.get(request.jobId)
    } catch {
      return null
    }
    if (!entry || !this.matchesJournalRequest(request, entry.request)) return null
    if (!entry.result.artifactRefs.includes(artifactRef)) return null
    const logPath = join(
      this.logsDir,
      `${createHash('sha256').update(request.jobId).digest('hex')}.log`,
    )
    return existsSync(logPath) ? logPath : null
  }

  readEvidence(request: Request, artifactRef: string, maxBytes: number): string | null {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return null
    const path = this.resolveEvidence(request, artifactRef)
    if (!path) return null
    const bytes = readFileSync(path)
    return bytes.subarray(0, Math.min(maxBytes, MAX_OUTPUT_BYTES)).toString('utf8')
  }

  private repairBaseRef(request: Request): string {
    return `${this.executionRefBase(request)}/failed-${request.operation}-base`
  }

  private freezeRepairBase(request: Request, base: string): string | null {
    const ref = this.repairBaseRef(request)
    const frozen = gitResult(request.repoPath, ['update-ref', ref, base, ZERO_SHA])
    return frozen.ok || refTip(request.repoPath, ref) === base
      ? null
      : frozen.stderr || 'failed repair base raced'
  }

  private deterministicRepairBase(request: Request): string | null {
    if (request.operation === 'validate') return refTip(request.repoPath, this.shadowRef(request))
    const members = this.trainMembers(request)
    if (members.length === 0) return request.expectedTargetSha
    let candidate = request.expectedTargetSha
    for (const [ordinal, member] of members.entries()) {
      const recorded = refTip(request.repoPath, this.memberResultRef(request, ordinal))
      if (!recorded) break
      if (
        !isAncestor(request.repoPath, candidate, recorded) ||
        !isAncestor(request.repoPath, member.approvedHeadSha, recorded)
      ) {
        return null
      }
      candidate = recorded
    }
    return candidate
  }

  private validFrozenRepair(input: {
    authority: Request
    base: string
    candidate: string
    contextDigest: string
    patch: string
    touchedPaths: string[]
    requireComposition?: boolean
  }): boolean {
    if (!isAncestor(input.authority.repoPath, input.base, input.candidate)) return false
    const commits = gitResult(input.authority.repoPath, [
      'rev-list',
      '--first-parent',
      '--reverse',
      `${input.base}..${input.candidate}`,
    ])
    const patchCommit = commits.stdout.split('\n').filter(Boolean)[0]
    if (!commits.ok || !patchCommit) return false
    const message = gitResult(input.authority.repoPath, ['log', '-1', '--format=%B', patchCommit])
    if (!message.ok || message.stdout !== `Podium repair ${input.contextDigest}`) return false
    const parent = gitResult(input.authority.repoPath, ['rev-parse', `${patchCommit}^1`])
    if (!parent.ok || parent.stdout !== input.base) return false
    const touched = gitResult(input.authority.repoPath, [
      'diff',
      '--name-only',
      input.base,
      patchCommit,
    ])
    if (
      !touched.ok ||
      JSON.stringify(touched.stdout.split('\n').filter(Boolean).sort()) !==
        JSON.stringify([...new Set(input.touchedPaths)].sort())
    ) {
      return false
    }
    const suppliedPatchId = run('git', ['patch-id', '--stable'], { input: input.patch })
    const frozenPatch = gitResult(input.authority.repoPath, [
      'show',
      '--format=',
      '--binary',
      patchCommit,
    ])
    const frozenPatchId = frozenPatch.ok
      ? run('git', ['patch-id', '--stable'], { input: frozenPatch.stdout })
      : null
    if (
      !suppliedPatchId.ok ||
      !frozenPatchId?.ok ||
      suppliedPatchId.stdout.split(/\s+/)[0] !== frozenPatchId.stdout.split(/\s+/)[0]
    ) {
      return false
    }
    if (!isAncestor(input.authority.repoPath, input.authority.expectedTargetSha, patchCommit)) {
      return false
    }
    const requiredHeads = this.trainMembers(input.authority).map((member) => member.approvedHeadSha)
    if (requiredHeads.length === 0) requiredHeads.push(input.authority.approvedHeadSha)
    const composition = gitResult(input.authority.repoPath, [
      'rev-list',
      '--first-parent',
      '--reverse',
      `${patchCommit}..${input.candidate}`,
    ])
    if (!composition.ok) return false
    const actual = composition.stdout.split('\n').filter(Boolean)
    let candidate = patchCommit
    for (const approvedHead of requiredHeads) {
      if (isAncestor(input.authority.repoPath, approvedHead, candidate)) continue
      const mergeCommit = actual.shift()
      if (!mergeCommit) return input.requireComposition === false && candidate === input.candidate
      const parents = gitResult(input.authority.repoPath, [
        'show',
        '-s',
        '--format=%P',
        mergeCommit,
      ])
      if (!parents.ok || parents.stdout !== `${candidate} ${approvedHead}`) return false
      const expectedTree = gitResult(input.authority.repoPath, [
        'merge-tree',
        '--write-tree',
        candidate,
        approvedHead,
      ])
      const actualTree = gitResult(input.authority.repoPath, [
        'show',
        '-s',
        '--format=%T',
        mergeCommit,
      ])
      if (
        !expectedTree.ok ||
        !actualTree.ok ||
        expectedTree.stdout.split('\n')[0] !== actualTree.stdout
      ) {
        return false
      }
      candidate = mergeCommit
    }
    return actual.length === 0 && candidate === input.candidate
  }

  private completeRepairComposition(
    authority: Request,
    repairPath: string,
    start: string,
  ): string | null {
    let candidate = start
    const requiredHeads = this.trainMembers(authority).map((member) => member.approvedHeadSha)
    if (requiredHeads.length === 0) requiredHeads.push(authority.approvedHeadSha)
    for (const approvedHead of requiredHeads) {
      if (isAncestor(authority.repoPath, approvedHead, candidate)) continue
      const merged = gitResult(repairPath, [
        '-c',
        'user.name=Podium Shipwright',
        '-c',
        'user.email=shipwright@podium.local',
        'merge',
        '--no-edit',
        '--',
        approvedHead,
      ])
      if (!merged.ok) {
        gitResult(repairPath, ['merge', '--abort'])
        return null
      }
      candidate = refTip(repairPath, 'HEAD') ?? ''
    }
    return candidate
  }

  applyPatch(input: {
    authority: Request
    contextDigest: string
    repairBaseSha: string
    repairRef: string
    patch: string
    touchedPaths: string[]
  }): { ok: boolean; summary: string; candidateHeadSha?: string; artifactRefs: string[] } {
    const { authority } = input
    if (
      authority.requestDigest !== this.requestDigest(authority) ||
      (authority.operation !== 'prepare-merge-group' && authority.operation !== 'validate') ||
      input.repairRef !==
        shipRepairRef(
          authority.orderId,
          authority.attemptId,
          authority.generation,
          input.contextDigest,
        )
    ) {
      return { ok: false, summary: 'repair patch authority fence failed', artifactRefs: [] }
    }
    if (
      input.touchedPaths.length === 0 ||
      input.touchedPaths.some(
        (path) => path.startsWith('/') || path.split('/').includes('..') || path.startsWith('-'),
      )
    ) {
      return { ok: false, summary: 'repair patch path authority failed', artifactRefs: [] }
    }
    const base = refTip(authority.repoPath, this.repairBaseRef(authority))
    const expectedBase = this.deterministicRepairBase(authority)
    if (!base || !expectedBase || base !== expectedBase || base !== input.repairBaseSha) {
      return {
        ok: false,
        summary: 'failed shipping effect has no exact immutable repair base',
        artifactRefs: [],
      }
    }
    const existingRepair = refTip(authority.repoPath, input.repairRef)
    if (existingRepair) {
      if (
        !this.validFrozenRepair({
          authority,
          base,
          candidate: existingRepair,
          contextDigest: input.contextDigest,
          patch: input.patch,
          touchedPaths: input.touchedPaths,
        })
      ) {
        return {
          ok: false,
          summary: 'existing repair ref is not the deterministic patch result',
          artifactRefs: [],
        }
      }
      return {
        ok: true,
        summary: `repair candidate ${existingRepair} already frozen`,
        candidateHeadSha: existingRepair,
        artifactRefs: [],
      }
    }
    const repairPath = join(
      this.integrationDir,
      `repair-${createHash('sha256').update(input.repairRef).digest('hex')}`,
    )
    const registered = worktrees(authority.repoPath).find(
      (candidate) => candidate.path === repairPath,
    )
    if (!registered) {
      if (existsSync(repairPath)) {
        return { ok: false, summary: 'repair path exists outside git custody', artifactRefs: [] }
      }
      const added = gitResult(authority.repoPath, [
        'worktree',
        'add',
        '--detach',
        '--',
        repairPath,
        base,
      ])
      if (!added.ok) return { ok: false, summary: added.stderr, artifactRefs: [] }
    } else if (registered.branch || !clean(repairPath)) {
      return { ok: false, summary: 'repair checkout custody changed', artifactRefs: [] }
    } else if (refTip(repairPath, 'HEAD') !== base) {
      const resumedHead = refTip(repairPath, 'HEAD')
      if (
        !resumedHead ||
        !this.validFrozenRepair({
          authority,
          base,
          candidate: resumedHead,
          contextDigest: input.contextDigest,
          patch: input.patch,
          touchedPaths: input.touchedPaths,
          requireComposition: false,
        })
      ) {
        return { ok: false, summary: 'repair checkout custody changed', artifactRefs: [] }
      }
      const composed = this.completeRepairComposition(authority, repairPath, resumedHead)
      if (
        !composed ||
        !this.validFrozenRepair({
          authority,
          base,
          candidate: composed,
          contextDigest: input.contextDigest,
          patch: input.patch,
          touchedPaths: input.touchedPaths,
        })
      ) {
        return {
          ok: false,
          summary: 'recovered repair did not complete approved composition',
          artifactRefs: [],
        }
      }
      const resumed = gitResult(authority.repoPath, [
        'update-ref',
        input.repairRef,
        composed,
        ZERO_SHA,
      ])
      if (!resumed.ok && refTip(authority.repoPath, input.repairRef) !== composed) {
        return {
          ok: false,
          summary: resumed.stderr || 'repair ref recovery raced',
          artifactRefs: [],
        }
      }
      return {
        ok: true,
        summary: `repair candidate ${composed} recovered`,
        candidateHeadSha: composed,
        artifactRefs: [],
      }
    }
    const checked = run('git', ['apply', '--check', '--index', '-'], {
      cwd: repairPath,
      input: input.patch,
    })
    if (!checked.ok) return { ok: false, summary: checked.stderr, artifactRefs: [] }
    const applied = run('git', ['apply', '--index', '-'], { cwd: repairPath, input: input.patch })
    if (!applied.ok) return { ok: false, summary: applied.stderr, artifactRefs: [] }
    const touched = gitResult(repairPath, ['diff', '--cached', '--name-only'])
    const actualPaths = touched.stdout.split('\n').filter(Boolean).sort()
    const declaredPaths = [...new Set(input.touchedPaths)].sort()
    if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
      gitResult(repairPath, ['reset', '--hard', base])
      return { ok: false, summary: 'repair patch touched undeclared paths', artifactRefs: [] }
    }
    const committed = gitResult(repairPath, [
      '-c',
      'user.name=Podium Shipwright',
      '-c',
      'user.email=shipwright@podium.local',
      'commit',
      '-m',
      `Podium repair ${input.contextDigest}`,
    ])
    if (!committed.ok) return { ok: false, summary: committed.stderr, artifactRefs: [] }
    const candidateHeadSha = refTip(repairPath, 'HEAD')
    if (!candidateHeadSha) {
      return { ok: false, summary: 'repair commit has no head', artifactRefs: [] }
    }
    const composedHead = this.completeRepairComposition(authority, repairPath, candidateHeadSha)
    if (
      !composedHead ||
      !this.validFrozenRepair({
        authority,
        base,
        candidate: composedHead,
        contextDigest: input.contextDigest,
        patch: input.patch,
        touchedPaths: input.touchedPaths,
      })
    ) {
      return {
        ok: false,
        summary: 'repair candidate does not contain approved composition',
        artifactRefs: [],
      }
    }
    const frozen = gitResult(authority.repoPath, [
      'update-ref',
      input.repairRef,
      composedHead,
      ZERO_SHA,
    ])
    if (!frozen.ok && refTip(authority.repoPath, input.repairRef) !== composedHead) {
      return { ok: false, summary: frozen.stderr || 'repair ref raced', artifactRefs: [] }
    }
    return {
      ok: true,
      summary: `repair candidate ${composedHead} frozen`,
      candidateHeadSha: composedHead,
      artifactRefs: [],
    }
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
    const manifest = this.trainManifest(request)
    const trainMembers = this.trainMembers(request)
    if (manifest) {
      const leader = manifest.members.at(-1)
      if (
        manifest.leaderOrderId !== request.orderId ||
        leader?.orderId !== request.orderId ||
        leader.attemptId !== request.attemptId ||
        leader.generation !== request.generation
      ) {
        return this.observed(
          request,
          'held',
          'invalid-request',
          'train leader does not match executor custody',
          sourceSha,
          targetSha,
        )
      }
      for (const member of trainMembers) {
        const observed = refTip(request.repoPath, `refs/heads/${member.sourceBranch}`)
        if (
          observed !== member.approvedHeadSha ||
          !isAncestor(request.repoPath, member.approvedBaseSha, observed ?? '')
        ) {
          return this.observed(
            request,
            'held',
            'source-moved',
            `train member ${member.orderId} source fence changed`,
            sourceSha,
            targetSha,
          )
        }
      }
    }
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
    const members = this.trainMembers(request)
    if (members.length > 0) return this.prepareTrain(request, members)
    const candidate = request.repair?.candidateHeadSha ?? request.approvedHeadSha
    if (!isAncestor(request.repoPath, request.expectedTargetSha, candidate)) {
      const freezeError = this.freezeRepairBase(request, request.expectedTargetSha)
      if (freezeError) {
        return this.observed(request, 'held', 'invalid-request', freezeError)
      }
      return {
        ...this.observed(
          request,
          'held',
          'merge-conflict',
          'candidate is not a fast-forward of the frozen target',
        ),
        repairBaseSha: request.expectedTargetSha,
      }
    }
    if (request.repair) {
      const applied = this.proof(request, 'apply-repair')
      if (applied?.state !== 'succeeded' || applied.testedIntegrationSha !== candidate) {
        return this.observed(
          request,
          'held',
          'invalid-request',
          'repair candidate has no exact apply proof',
        )
      }
    }
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

  private prepareTrain(
    request: Request,
    members: ReturnType<ShippingExecutionPlane['trainMembers']>,
  ): Result {
    const shadow = this.shadowRef(request)
    if (request.repair) {
      const applied = this.proof(request, 'apply-repair')
      const repairedProofs = applied?.trainProofs
      if (
        applied?.state !== 'succeeded' ||
        applied.testedIntegrationSha !== request.repair.candidateHeadSha ||
        !repairedProofs
      ) {
        return this.observed(
          request,
          'held',
          'invalid-request',
          'repair candidate lacks apply proof or exact approved member results',
        )
      }
      const created = gitResult(request.repoPath, [
        'update-ref',
        shadow,
        request.repair.candidateHeadSha,
        ZERO_SHA,
      ])
      if (!created.ok && refTip(request.repoPath, shadow) !== request.repair.candidateHeadSha) {
        return this.observed(
          request,
          'held',
          'source-moved',
          created.stderr || 'repair shadow raced',
        )
      }
      const integration = this.ensureIntegrationCheckout(request, request.repair.candidateHeadSha)
      if ('classification' in integration) return integration
      return {
        ...this.observed(
          request,
          'succeeded',
          'proved',
          `repair train prepared at ${request.repair.candidateHeadSha}`,
        ),
        testedIntegrationSha: request.repair.candidateHeadSha,
        trainProofs: repairedProofs,
        logs: [
          `shadow ${shadow} ${request.repair.candidateHeadSha}`,
          `integration checkout ${integration.path}`,
        ],
      }
    }
    const existingCandidate = refTip(request.repoPath, shadow)
    if (existingCandidate) {
      const integration = this.ensureIntegrationCheckout(request, existingCandidate)
      if ('classification' in integration) return integration
      const proofs: NonNullable<Result['trainProofs']> = []
      for (const [ordinal, member] of members.entries()) {
        const resultCommitSha = refTip(request.repoPath, this.memberResultRef(request, ordinal))
        if (!resultCommitSha) {
          return this.observed(
            request,
            'held',
            'invalid-request',
            `train member proof ${ordinal} is absent; final candidate cannot substitute for it`,
          )
        }
        proofs.push({
          issueId: member.issueId,
          orderId: member.orderId,
          attemptId: member.attemptId,
          generation: member.generation,
          sourceApprovedSha: member.approvedHeadSha,
          resultCommitSha,
        })
      }
      return {
        ...this.observed(
          request,
          'succeeded',
          'proved',
          `immutable train prepared at ${existingCandidate}`,
        ),
        testedIntegrationSha: existingCandidate,
        trainProofs: proofs,
        logs: [`shadow ${shadow} ${existingCandidate}`, `integration checkout ${integration.path}`],
      }
    }

    const path = join(this.integrationDir, this.executionKey(request))
    const registered = worktrees(request.repoPath).find((entry) => entry.path === path)
    if (!registered) {
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
        request.expectedTargetSha,
      ])
      if (!added.ok) {
        return this.observed(
          request,
          'held',
          'invalid-request',
          added.stderr || added.stdout || 'could not create train checkout',
        )
      }
    } else if (registered.branch || !clean(path)) {
      return this.observed(
        request,
        'held',
        'dirty-worktree',
        `integration checkout is not clean and detached: ${path}`,
      )
    }

    const proofs: NonNullable<Result['trainProofs']> = []
    let candidate = refTip(path, 'HEAD') ?? request.expectedTargetSha
    for (const [ordinal, member] of members.entries()) {
      const memberRef = this.memberResultRef(request, ordinal)
      const recorded = refTip(request.repoPath, memberRef)
      if (recorded) {
        if (!isAncestor(request.repoPath, member.approvedHeadSha, recorded)) {
          return this.observed(
            request,
            'held',
            'invalid-request',
            `train member proof ${ordinal} contradicts its approved head`,
          )
        }
        if (candidate !== recorded) {
          const checkout = gitResult(path, ['checkout', '--detach', recorded])
          if (!checkout.ok)
            return this.observed(
              request,
              'held',
              'invalid-request',
              checkout.stderr || 'could not resume train composition',
            )
          candidate = recorded
        }
      } else {
        if (!isAncestor(request.repoPath, member.approvedHeadSha, candidate)) {
          const merged = gitResult(path, [
            '-c',
            'user.name=Podium Shipping',
            '-c',
            'user.email=shipping@podium.local',
            'merge',
            '--no-edit',
            '--',
            member.approvedHeadSha,
          ])
          if (!merged.ok) {
            gitResult(path, ['merge', '--abort'])
            const freezeError = this.freezeRepairBase(request, candidate)
            if (freezeError) {
              return this.observed(request, 'held', 'invalid-request', freezeError)
            }
            return {
              ...this.observed(
                request,
                'held',
                'merge-conflict',
                merged.stderr || merged.stdout || `train member ${member.orderId} conflicts`,
              ),
              repairBaseSha: candidate,
            }
          }
          candidate = refTip(path, 'HEAD') ?? ''
        }
        const recordedMember = gitResult(request.repoPath, [
          'update-ref',
          memberRef,
          candidate,
          ZERO_SHA,
        ])
        if (!recordedMember.ok && refTip(request.repoPath, memberRef) !== candidate) {
          return this.observed(
            request,
            'held',
            'invalid-request',
            recordedMember.stderr || 'train member proof raced',
          )
        }
      }
      proofs.push({
        issueId: member.issueId,
        orderId: member.orderId,
        attemptId: member.attemptId,
        generation: member.generation,
        sourceApprovedSha: member.approvedHeadSha,
        resultCommitSha: candidate,
      })
    }
    const created = gitResult(request.repoPath, ['update-ref', shadow, candidate, ZERO_SHA])
    if (!created.ok && refTip(request.repoPath, shadow) !== candidate) {
      return this.observed(
        request,
        'held',
        'target-moved',
        created.stderr || 'train shadow ref raced',
      )
    }
    return {
      ...this.observed(request, 'succeeded', 'proved', `immutable train prepared at ${candidate}`),
      testedIntegrationSha: candidate,
      trainProofs: proofs,
      logs: [`shadow ${shadow} ${candidate}`, `integration checkout ${path}`],
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
    const prepared = this.proof(request, 'prepare-merge-group')
    const trainProofs = prepared?.trainProofs?.map((proof) => ({
      ...proof,
      testedIntegrationSha: candidate,
    }))
    if (
      request.train &&
      (!prepared || prepared.testedIntegrationSha !== candidate || !trainProofs)
    ) {
      return this.observed(
        request,
        'held',
        'invalid-request',
        'train candidate has no exact preparation proof',
      )
    }
    if (!passed) {
      const freezeError = this.freezeRepairBase(request, candidate)
      if (freezeError) {
        return this.observed(request, 'held', 'invalid-request', freezeError)
      }
    }
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
      ...(passed ? {} : { repairBaseSha: candidate }),
      validationProfileId: request.validationProfile.id,
      validationResult: passed ? 'passed' : 'failed',
      ...(trainProofs ? { trainProofs } : {}),
      artifactRefs: [this.evidenceRef(request, 0)],
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
    if (
      !request.train &&
      sourceSha === request.approvedHeadSha &&
      candidate !== request.approvedHeadSha
    ) {
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
    const trainProofs = validation.trainProofs?.map((proof) => ({
      ...proof,
      landedRefSha: candidate,
    }))
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
      ...(trainProofs ? { trainProofs } : {}),
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
      const trainProofs = context.trainProofs?.map((member) => ({
        ...member,
        providerLandedRefSha: proof.landedRefSha,
      }))
      return {
        ...this.observed(request, 'succeeded', 'proved', `published through ${adapter.id}`),
        testedIntegrationSha: context.testedIntegrationSha,
        landedRefSha: proof.landedRefSha,
        ...(proof.destinationSha ? { observedDestinationSha: proof.destinationSha } : {}),
        validationProfileId: request.validationProfile.id,
        validationResult: 'passed',
        ...(trainProofs ? { trainProofs } : {}),
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
      const trainProofs = context.trainProofs?.map((member) => ({
        ...member,
        destinationSha: proof.destinationSha,
      }))
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
        ...(trainProofs ? { trainProofs } : {}),
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
      ...((published?.trainProofs ?? committed.trainProofs)
        ? { trainProofs: published?.trainProofs ?? committed.trainProofs }
        : {}),
    }
  }

  private provider(request: Request): ShippingProviderAdapter | undefined {
    return this.providers.find((adapter) => adapter.matches(request))
  }

  private proof(request: Request, operation: Request['operation']): Result | null {
    const {
      type: _type,
      requestId: _requestId,
      action: _action,
      requestDigest: _digest,
      ...facts
    } = request
    const expectedJobId = this.operationJobId(request, operation)
    const expectedDigest = createHash('sha256')
      .update(
        shippingJobRequestFingerprint({
          ...facts,
          jobId: expectedJobId,
          operation,
        }),
      )
      .digest('hex')
    const entry = this.journal
      .list()
      .filter(
        (candidate) =>
          candidate.request.jobId === expectedJobId &&
          candidate.request.orderId === request.orderId &&
          candidate.request.attemptId === request.attemptId &&
          candidate.request.generation === request.generation &&
          candidate.request.operation === operation &&
          candidate.request.requestDigest === expectedDigest,
      )
      .at(-1)
    if (!entry) return null
    const { requestDigest, ...entryFacts } = entry.request
    const digest = createHash('sha256')
      .update(shippingJobRequestFingerprint(entryFacts))
      .digest('hex')
    return digest === requestDigest &&
      entry.result.jobId === entry.request.jobId &&
      entry.result.requestDigest === requestDigest &&
      entry.result.orderId === entry.request.orderId &&
      entry.result.attemptId === entry.request.attemptId &&
      entry.result.generation === entry.request.generation &&
      entry.result.operation === entry.request.operation &&
      shippingTrainProofsMatch(entry.request, entry.result)
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
    const path = join(this.integrationDir, this.executionKey(request))
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
    return `${this.executionRefBase(request)}/candidate`
  }

  private memberResultRef(request: Request, ordinal: number): string {
    return `${this.executionRefBase(request)}/members/${ordinal}`
  }

  private executionRefBase(request: Request): string {
    return `refs/podium/ship/${this.executionKey(request)}`
  }

  private executionKey(request: Request): string {
    const subset = request.train && 'manifest' in request.train ? request.train.subsetId : 'single'
    const repair = request.repair
      ? `-repair-${request.repair.round}-${request.repair.contextDigest}-${createHash('sha256')
          .update(`${request.repair.repairRef}\0${request.repair.candidateHeadSha}`)
          .digest('hex')}`
      : ''
    return `${safePart(request.orderId)}-${safePart(request.attemptId)}-${request.generation}-${safePart(subset)}${repair}`
  }

  private operationJobId(request: Request, operation: Request['operation']): string {
    if (request.train && 'manifest' in request.train) {
      return `${request.attemptId}:${operation}:${request.train.subsetId}`
    }
    if (request.repair) {
      return `${request.attemptId}:${operation}:repair-${request.repair.round}-${request.repair.contextDigest}-${createHash(
        'sha256',
      )
        .update(`${request.repair.repairRef}\0${request.repair.candidateHeadSha}`)
        .digest('hex')}`
    }
    return `${request.attemptId}:${operation}`
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
    const {
      type: _type,
      requestId: _requestId,
      action: _action,
      requestDigest: incomingDigest,
      ...incomingFacts
    } = request
    const { requestDigest: durableDigest, ...durableFacts } = durable
    const digest = (facts: Parameters<typeof shippingJobRequestFingerprint>[0]): string =>
      createHash('sha256').update(shippingJobRequestFingerprint(facts)).digest('hex')
    return (
      incomingDigest === digest(incomingFacts) &&
      durableDigest === digest(durableFacts) &&
      incomingDigest === durableDigest &&
      request.jobId === durable.jobId &&
      request.orderId === durable.orderId &&
      request.attemptId === durable.attemptId &&
      request.generation === durable.generation &&
      request.operation === durable.operation
    )
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
