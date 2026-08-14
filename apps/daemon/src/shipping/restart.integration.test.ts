import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asIssueId,
  asMachineId,
  asShipAttemptId,
  asShipOrderId,
  asShipTrainId,
  asShipTrainSubsetId,
  shipRepairRef,
} from '@podium/model'
import {
  shippingJobRequestFingerprint,
  shippingTrainSubsetFingerprint,
  type ShippingJobRequestMessage,
} from '@podium/protocol/daemon'
import { afterAll, describe, expect, it } from 'vitest'
import { ShippingExecutionPlane } from './executor'

const root = mkdtempSync(join(tmpdir(), 'podium-shipping-restart-'))
const repo = join(root, 'repo')
const journal = join(root, 'runtime')

const git = (...argv: string[]): string =>
  execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8' }).trim()

const signed = (
  input: Omit<ShippingJobRequestMessage, 'requestDigest'>,
): ShippingJobRequestMessage => {
  const { type: _type, requestId: _requestId, action: _action, ...facts } = input
  return {
    ...input,
    requestDigest: createHash('sha256').update(shippingJobRequestFingerprint(facts)).digest('hex'),
  }
}

const resetFixture = (...paths: string[]): void => {
  for (const path of paths) rmSync(path, { recursive: true, force: true })
}

const expectSucceeded = (
  result: ReturnType<ShippingExecutionPlane['handle']>,
  boundary: string,
): void => {
  expect(result, `${boundary}: ${result.classification}: ${result.summary}`).toMatchObject({
    state: 'succeeded',
  })
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('shipping daemon restart recovery', () => {
  it('recreates conflicted composition and refuses an unrelated existing repair ref', () => {
    resetFixture(repo, journal)
    execFileSync('git', ['init', '--initial-branch=main', repo])
    git('config', 'user.email', 'shipping@test.invalid')
    git('config', 'user.name', 'Shipping Test')
    writeFileSync(join(repo, 'value.txt'), 'base\n')
    git('add', 'value.txt')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('switch', '-c', 'issue/conflict')
    writeFileSync(join(repo, 'value.txt'), 'source\n')
    git('commit', '-am', 'source')
    const source = git('rev-parse', 'HEAD')
    git('switch', 'main')
    writeFileSync(join(repo, 'value.txt'), 'target\n')
    git('commit', '-am', 'target')
    const target = git('rev-parse', 'HEAD')
    const request = signed({
      type: 'shippingJobRequest',
      requestId: 'request-conflict',
      action: 'start',
      jobId: 'attempt-conflict:prepare-merge-group',
      orderId: asShipOrderId('order-conflict'),
      attemptId: asShipAttemptId('attempt-conflict'),
      generation: 1,
      operation: 'prepare-merge-group',
      shippingProtocolVersion: 1,
      repoPath: repo,
      repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
      sourceBranch: 'issue/conflict',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: source,
      expectedTargetSha: target,
      destination: 'local:main',
      policyId: 'proof-policy',
      validationProfile: {
        id: 'exact-proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root',
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    })
    const plane = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
    expect(plane.handle(request)).toMatchObject({ state: 'held', classification: 'merge-conflict' })
    resetFixture(journal)
    const recoveredPlane = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
    const contextDigest = 'c'.repeat(64)
    const repairRef = shipRepairRef(
      request.orderId,
      request.attemptId,
      request.generation,
      contextDigest,
    )
    const patch =
      'diff --git a/value.txt b/value.txt\n' +
      '--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-target\n+base\n'
    const repaired = recoveredPlane.applyPatch({
      authority: request,
      contextDigest,
      repairBaseSha: target,
      repairRef,
      patch,
      touchedPaths: ['value.txt'],
    })
    expect(repaired).toMatchObject({ ok: true, candidateHeadSha: expect.any(String) })
    expect(git('merge-base', '--is-ancestor', target, repaired.candidateHeadSha!)).toBe('')
    expect(git('merge-base', '--is-ancestor', source, repaired.candidateHeadSha!)).toBe('')

    const repairedTree = git('rev-parse', `${repaired.candidateHeadSha!}^{tree}`)
    const extraDescendant = git(
      'commit-tree',
      repairedTree,
      '-p',
      repaired.candidateHeadSha!,
      '-m',
      'unreviewed descendant',
    )
    git('update-ref', repairRef, extraDescendant, repaired.candidateHeadSha!)
    expect(
      recoveredPlane.applyPatch({
        authority: request,
        contextDigest,
        repairBaseSha: target,
        repairRef,
        patch,
        touchedPaths: ['value.txt'],
      }),
    ).toMatchObject({ ok: false, summary: expect.stringMatching(/deterministic patch result/) })

    git('update-ref', repairRef, source, extraDescendant)
    expect(
      recoveredPlane.applyPatch({
        authority: request,
        contextDigest,
        repairBaseSha: target,
        repairRef,
        patch,
        touchedPaths: ['value.txt'],
      }),
    ).toMatchObject({ ok: false, summary: expect.stringMatching(/deterministic patch result/) })
  })

  it('refuses coordinated shadow/base and partial-member/base movement', () => {
    resetFixture(repo, journal)
    execFileSync('git', ['init', '--initial-branch=main', repo])
    git('config', 'user.email', 'shipping@test.invalid')
    git('config', 'user.name', 'Shipping Test')
    writeFileSync(join(repo, 'value.txt'), 'base\n')
    git('add', 'value.txt')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('switch', '-c', 'issue/validation')
    writeFileSync(join(repo, 'value.txt'), 'approved\n')
    git('commit', '-am', 'approved')
    const approved = git('rev-parse', 'HEAD')
    git('switch', 'main')
    const validationFacts = {
      type: 'shippingJobRequest' as const,
      requestId: 'request-validation-base',
      action: 'start' as const,
      orderId: asShipOrderId('order-validation-base'),
      attemptId: asShipAttemptId('attempt-validation-base'),
      generation: 1,
      shippingProtocolVersion: 1 as const,
      repoPath: repo,
      repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
      sourceBranch: 'issue/validation',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: approved,
      expectedTargetSha: base,
      destination: 'local:main',
      policyId: 'proof-policy',
      validationProfile: {
        id: 'always-fails',
        argv: ['git', 'diff', '--quiet', 'HEAD^', 'HEAD'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    const plane = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
    expect(
      plane.handle(
        signed({
          ...validationFacts,
          jobId: 'attempt-validation-base:prepare-merge-group',
          operation: 'prepare-merge-group',
        }),
      ),
    ).toMatchObject({ state: 'succeeded', testedIntegrationSha: approved })
    const validationRequest = signed({
      ...validationFacts,
      jobId: 'attempt-validation-base:validate',
      operation: 'validate',
    })
    const validationFailure = plane.handle(validationRequest)
    expect(validationFailure).toMatchObject({
      state: 'held',
      classification: 'validation-failed',
      repairBaseSha: approved,
    })
    const unapproved = git(
      'commit-tree',
      git('rev-parse', `${approved}^{tree}`),
      '-p',
      approved,
      '-m',
      'unapproved validation descendant',
    )
    const validationRefs = git('for-each-ref', '--format=%(refname)', 'refs/podium/ship').split(
      '\n',
    )
    const shadowRef = validationRefs.find((ref) => ref.endsWith('/candidate'))!
    const validationBaseRef = validationRefs.find((ref) => ref.endsWith('/failed-validate-base'))!
    git('update-ref', shadowRef, unapproved, approved)
    git('update-ref', validationBaseRef, unapproved, approved)
    resetFixture(journal)
    expect(
      new ShippingExecutionPlane(journal, asMachineId('machine-1')).applyPatch({
        authority: validationRequest,
        contextDigest: 'a'.repeat(64),
        repairBaseSha: approved,
        repairRef: shipRepairRef(
          validationRequest.orderId,
          validationRequest.attemptId,
          validationRequest.generation,
          'a'.repeat(64),
        ),
        patch:
          'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-approved\n+fixed\n',
        touchedPaths: ['value.txt'],
      }),
    ).toMatchObject({ ok: false, summary: expect.stringMatching(/exact immutable repair base/) })

    resetFixture(repo, journal)
    execFileSync('git', ['init', '--initial-branch=main', repo])
    git('config', 'user.email', 'shipping@test.invalid')
    git('config', 'user.name', 'Shipping Test')
    writeFileSync(join(repo, 'value.txt'), 'base\n')
    git('add', 'value.txt')
    git('commit', '-m', 'base')
    const trainBase = git('rev-parse', 'HEAD')
    git('switch', '-c', 'issue/member-1')
    writeFileSync(join(repo, 'value.txt'), 'member one\n')
    git('commit', '-am', 'member one')
    const memberOne = git('rev-parse', 'HEAD')
    git('switch', '-c', 'issue/member-2', trainBase)
    writeFileSync(join(repo, 'value.txt'), 'member two\n')
    git('commit', '-am', 'member two')
    const memberTwo = git('rev-parse', 'HEAD')
    git('switch', 'main')
    const memberOrderIds = [asShipOrderId('order-member-1'), asShipOrderId('order-member-2')]
    const trainId = asShipTrainId('train-partial-conflict')
    const subsetId = asShipTrainSubsetId(
      `subset:${createHash('sha256')
        .update(
          shippingTrainSubsetFingerprint({
            manifest: { id: trainId },
            memberOrderIds,
            repairRound: 0,
            candidate: { kind: 'approved' },
          }),
        )
        .digest('hex')}`,
    )
    const machineId = asMachineId('machine-1')
    const validationProfile = {
      id: 'train-proof',
      argv: ['git', 'diff', '--quiet'],
      cwd: 'integration-root' as const,
      timeoutMs: 30_000,
      resourceLocks: [],
    }
    const manifest = {
      version: 1 as const,
      id: trainId,
      subsetId,
      repairRound: 0 as const,
      lane: {
        repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
        repoPath: repo,
        machineId,
        laneKey: 'b'.repeat(64),
        laneRevision: 1,
        targetBranch: 'main',
        expectedTargetSha: trainBase,
        destination: 'local:main',
        policyId: 'proof-policy',
        validationProfile,
        validationProfileDigest: 'c'.repeat(64),
      },
      memberCount: 2,
      leaderOrderId: memberOrderIds[1]!,
      members: [
        {
          orderId: memberOrderIds[0]!,
          issueId: asIssueId('issue-member-1'),
          attemptId: asShipAttemptId('attempt-member-1'),
          generation: 1,
          machineId,
          sourceBranch: 'issue/member-1',
          approvedBaseSha: trainBase,
          approvedHeadSha: memberOne,
          deliveryDependsOn: [],
        },
        {
          orderId: memberOrderIds[1]!,
          issueId: asIssueId('issue-member-2'),
          attemptId: asShipAttemptId('attempt-member-2'),
          generation: 1,
          machineId,
          sourceBranch: 'issue/member-2',
          approvedBaseSha: trainBase,
          approvedHeadSha: memberTwo,
          deliveryDependsOn: [memberOrderIds[0]!],
        },
      ],
    }
    const trainRequest = signed({
      type: 'shippingJobRequest',
      requestId: 'request-partial-train',
      action: 'start',
      jobId: 'attempt-member-2:prepare-merge-group',
      orderId: memberOrderIds[1]!,
      attemptId: asShipAttemptId('attempt-member-2'),
      generation: 1,
      operation: 'prepare-merge-group',
      shippingProtocolVersion: 2,
      repoPath: repo,
      repoId: manifest.lane.repoId,
      sourceBranch: 'issue/member-2',
      targetBranch: 'main',
      approvedBaseSha: trainBase,
      approvedHeadSha: memberTwo,
      expectedTargetSha: trainBase,
      destination: 'local:main',
      policyId: 'proof-policy',
      validationProfile,
      train: {
        version: 2,
        capability: 'shipping.train.v2',
        manifest,
        subsetId,
        memberOrderIds,
        repairRound: 0,
        candidate: { kind: 'approved' },
      },
    })
    const trainPlane = new ShippingExecutionPlane(journal, machineId)
    const trainFailure = trainPlane.handle(trainRequest)
    expect(trainFailure).toMatchObject({
      state: 'held',
      classification: 'merge-conflict',
      repairBaseSha: memberOne,
    })
    const unapprovedMember = git(
      'commit-tree',
      git('rev-parse', `${memberOne}^{tree}`),
      '-p',
      memberOne,
      '-m',
      'unapproved member descendant',
    )
    const trainRefs = git('for-each-ref', '--format=%(refname)', 'refs/podium/ship').split('\n')
    const memberRef = trainRefs.find((ref) => ref.endsWith('/members/0'))!
    const trainBaseRef = trainRefs.find((ref) => ref.endsWith('/failed-prepare-merge-group-base'))!
    git('update-ref', memberRef, unapprovedMember, memberOne)
    git('update-ref', trainBaseRef, unapprovedMember, memberOne)
    resetFixture(journal)
    expect(
      new ShippingExecutionPlane(journal, machineId).applyPatch({
        authority: trainRequest,
        contextDigest: 'd'.repeat(64),
        repairBaseSha: memberOne,
        repairRef: shipRepairRef(
          trainRequest.orderId,
          trainRequest.attemptId,
          trainRequest.generation,
          'd'.repeat(64),
        ),
        patch:
          'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-member one\n+fixed\n',
        touchedPaths: ['value.txt'],
      }),
    ).toMatchObject({ ok: false, summary: expect.stringMatching(/exact immutable repair base/) })
  })

  it('proves or holds without mutating refs and resumes from its journal', () => {
    resetFixture(repo, journal)
    execFileSync('git', ['init', '--initial-branch=main', repo])
    git('config', 'user.email', 'shipping@test.invalid')
    git('config', 'user.name', 'Shipping Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git('add', 'base.txt')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('switch', '-c', 'issue/1')
    writeFileSync(join(repo, 'change.txt'), 'change\n')
    git('add', 'change.txt')
    git('commit', '-m', 'change')
    const head = git('rev-parse', 'HEAD')
    git('switch', 'main')

    const common = {
      type: 'shippingJobRequest' as const,
      requestId: 'request-1',
      action: 'start' as const,
      jobId: 'attempt-1:preflight',
      orderId: asShipOrderId('order-1'),
      attemptId: asShipAttemptId('attempt-1'),
      generation: 1,
      operation: 'preflight' as const,
      shippingProtocolVersion: 2 as const,
      repoPath: repo,
      repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
      sourceBranch: 'issue/1',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: head,
      expectedTargetSha: base,
      destination: 'local:main',
      policyId: 'proof-policy',
      validationProfile: {
        id: 'exact-proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    const operations = [
      'preflight',
      'prepare-merge-group',
      'validate',
      'commit-merge-group',
      'publish',
      'verify',
    ] as const
    for (const operation of operations) {
      let plane = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
      const request = signed({
        ...common,
        requestId: `request-${operation}`,
        jobId: `attempt-1:${operation}`,
        operation,
      })
      // Crash boundary one: the durable start exists but the process died before
      // recording a terminal result. A fresh executor must observe/replay it.
      plane.journal.begin(request, {
        jobId: request.jobId,
        requestDigest: request.requestDigest,
        orderId: request.orderId,
        attemptId: request.attemptId,
        machineId: asMachineId('machine-1'),
        generation: request.generation,
        operation,
        state: 'running',
        classification: 'observed',
        summary: 'effect started before crash',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
      })
      if (operation === 'commit-merge-group') {
        // Crash boundary two: both real refs crossed their CAS boundary but the
        // terminal journal write did not. Replay proves the intended exact tip.
        git('merge', '--ff-only', head)
      }
      plane = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
      const result = plane.handle(request)
      expectSucceeded(result, `local ${operation} recovery`)
      if (operation !== 'preflight') {
        expect(result).toMatchObject({ testedIntegrationSha: head })
      }
      // Crash boundary three: terminal daemon proof exists but no server ack.
      // Both status and duplicate start return byte-for-byte stable evidence.
      const afterTerminalRestart = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
      expect(
        afterTerminalRestart.handle(
          signed({ ...request, requestId: `${request.requestId}-status`, action: 'status' }),
        ),
      ).toEqual(result)
      expect(
        afterTerminalRestart.handle(
          signed({ ...request, requestId: `${request.requestId}-replay` }),
        ),
      ).toEqual(result)
      if (
        operation === 'preflight' ||
        operation === 'prepare-merge-group' ||
        operation === 'validate'
      ) {
        expect(git('rev-parse', 'main')).toBe(base)
        expect(git('rev-parse', 'issue/1')).toBe(head)
      }
      if (operation === 'verify') {
        expect(result).toMatchObject({
          landedRefSha: head,
          observedDestinationSha: head,
          validationProfileId: 'exact-proof',
          validationResult: 'passed',
        })
      }
    }
    expect(git('rev-parse', 'main')).toBe(head)
    expect(git('rev-parse', 'issue/1')).toBe(head)
    const recovered = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
    expect(
      recovered.handle(
        signed({
          ...common,
          requestId: 'request-new-generation',
          jobId: 'attempt-2:preflight',
          attemptId: asShipAttemptId('attempt-2'),
          generation: 2,
          operation: 'preflight',
          expectedTargetSha: head,
        }),
      ),
    ).toMatchObject({ state: 'succeeded', classification: 'observed', generation: 2 })
    expect(
      recovered.handle(signed({ ...common, requestId: 'request-3', action: 'status' })),
    ).toMatchObject({ state: 'held', classification: 'stale-generation' })
  })

  it('publishes the exact tested commit through the non-force remote adapter', () => {
    const remoteRepo = join(root, 'remote-repo')
    const bare = join(root, 'destination.git')
    const runtime = join(root, 'remote-runtime')
    resetFixture(remoteRepo, bare, runtime)
    execFileSync('git', ['init', '--bare', bare])
    execFileSync('git', ['init', '--initial-branch=main', remoteRepo])
    const remoteGit = (...argv: string[]): string =>
      execFileSync('git', ['-C', remoteRepo, ...argv], { encoding: 'utf8' }).trim()
    remoteGit('config', 'user.email', 'shipping@test.invalid')
    remoteGit('config', 'user.name', 'Shipping Test')
    writeFileSync(join(remoteRepo, 'base.txt'), 'base\n')
    remoteGit('add', 'base.txt')
    remoteGit('commit', '-m', 'base')
    const base = remoteGit('rev-parse', 'HEAD')
    remoteGit('remote', 'add', 'origin', bare)
    remoteGit('push', 'origin', 'main')
    remoteGit('switch', '-c', 'issue/remote')
    writeFileSync(join(remoteRepo, 'change.txt'), 'change\n')
    remoteGit('add', 'change.txt')
    remoteGit('commit', '-m', 'change')
    const head = remoteGit('rev-parse', 'HEAD')
    remoteGit('switch', 'main')

    const plane = new ShippingExecutionPlane(runtime, asMachineId('machine-1'))
    const common = {
      type: 'shippingJobRequest' as const,
      requestId: 'remote-request',
      action: 'start' as const,
      orderId: asShipOrderId('remote-order'),
      attemptId: asShipAttemptId('remote-attempt'),
      generation: 1,
      shippingProtocolVersion: 2 as const,
      repoPath: remoteRepo,
      repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
      sourceBranch: 'issue/remote',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: head,
      expectedTargetSha: base,
      destination: 'git:origin/main',
      policyId: 'proof-policy',
      validationProfile: {
        id: 'remote-proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    for (const [index, destination] of [
      'git:-upload-pack/main',
      'git:origin/-upload-pack',
      'git:missing/main',
      'git:origin/../main',
    ].entries()) {
      const hostile = plane.handle(
        signed({
          ...common,
          requestId: `hostile-${index}`,
          jobId: `hostile-${index}:preflight`,
          orderId: asShipOrderId(`hostile-order-${index}`),
          attemptId: asShipAttemptId(`hostile-attempt-${index}`),
          operation: 'preflight',
          destination,
        }),
      )
      expect(hostile).toMatchObject({ state: 'held' })
      expect(
        execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe(base)
    }
    for (const operation of [
      'preflight',
      'prepare-merge-group',
      'validate',
      'commit-merge-group',
    ] as const) {
      expect(
        plane.handle(signed({ ...common, jobId: `remote-attempt:${operation}`, operation })),
      ).toMatchObject({ state: 'succeeded' })
    }
    const publishRequest = signed({
      ...common,
      requestId: 'remote-publish-after-crash',
      jobId: 'remote-attempt:publish',
      operation: 'publish',
      // Journal parsing may materialize schema fields in a different property
      // order. The canonical request fingerprint, not object insertion order,
      // is the immutable proof identity.
      validationProfile: {
        resourceLocks: [],
        timeoutMs: 30_000,
        cwd: 'integration-root',
        argv: ['git', 'diff', '--quiet'],
        id: 'remote-proof',
      },
    })
    remoteGit('push', 'origin', `${head}:refs/heads/main`)
    plane.journal.begin(publishRequest, {
      jobId: publishRequest.jobId,
      requestDigest: publishRequest.requestDigest,
      orderId: publishRequest.orderId,
      attemptId: publishRequest.attemptId,
      machineId: asMachineId('machine-1'),
      generation: publishRequest.generation,
      operation: 'publish',
      state: 'running',
      classification: 'observed',
      summary: 'remote accepted push before terminal journal write',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
    })
    expectSucceeded(plane.handle(publishRequest), 'remote publish replay')
    expectSucceeded(
      plane.handle(
        signed({
          ...common,
          requestId: 'remote-verify',
          jobId: 'remote-attempt:verify',
          operation: 'verify',
        }),
      ),
      'remote destination verification',
    )
    expect(
      execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(head)
    expect(plane.journal.get('remote-attempt:verify')?.result).toMatchObject({
      testedIntegrationSha: head,
      landedRefSha: head,
      observedDestinationSha: head,
      validationProfileId: 'remote-proof',
      validationResult: 'passed',
    })
  })

  it('creates a dedicated landing checkout only when the target is unowned', () => {
    const adoptionRepo = join(root, 'adoption-repo')
    const runtime = join(root, 'adoption-runtime')
    execFileSync('git', ['init', '--initial-branch=main', adoptionRepo])
    const adoptionGit = (...argv: string[]): string =>
      execFileSync('git', ['-C', adoptionRepo, ...argv], { encoding: 'utf8' }).trim()
    adoptionGit('config', 'user.email', 'shipping@test.invalid')
    adoptionGit('config', 'user.name', 'Shipping Test')
    writeFileSync(join(adoptionRepo, 'base.txt'), 'base\n')
    adoptionGit('add', 'base.txt')
    adoptionGit('commit', '-m', 'base')
    const base = adoptionGit('rev-parse', 'HEAD')
    adoptionGit('branch', 'issue/adoption')
    adoptionGit('switch', '--detach', base)

    const result = new ShippingExecutionPlane(runtime, asMachineId('machine-1')).handle(
      signed({
        type: 'shippingJobRequest',
        requestId: 'adoption-request',
        action: 'start',
        jobId: 'adoption-attempt:preflight',
        orderId: asShipOrderId('adoption-order'),
        attemptId: asShipAttemptId('adoption-attempt'),
        generation: 1,
        operation: 'preflight',
        shippingProtocolVersion: 2,
        repoPath: adoptionRepo,
        repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
        sourceBranch: 'issue/adoption',
        targetBranch: 'main',
        approvedBaseSha: base,
        approvedHeadSha: base,
        expectedTargetSha: base,
        destination: 'local:main',
        policyId: 'proof-policy',
        validationProfile: {
          id: 'adoption-proof',
          argv: ['git', 'diff', '--quiet'],
          cwd: 'integration-root',
          timeoutMs: 30_000,
          resourceLocks: [],
        },
      }),
    )
    expect(result).toMatchObject({ state: 'succeeded', classification: 'observed' })
    const mainOwner = adoptionGit('worktree', 'list', '--porcelain')
      .split(/\n\n+/)
      .find((entry) => entry.includes('branch refs/heads/main'))
    expect(mainOwner).toContain(join(runtime, 'landing-checkouts'))
  })

  it('does not reuse green proof across a different order or repository', () => {
    const proofRepo = join(root, 'proof-binding-repo')
    const secondRepo = join(root, 'proof-binding-second-repo')
    const runtime = join(root, 'proof-binding-runtime')
    const secondRuntime = join(root, 'proof-binding-second-runtime')
    resetFixture(proofRepo, secondRepo, runtime, secondRuntime)
    execFileSync('git', ['init', '--initial-branch=main', proofRepo])
    const proofGit = (...argv: string[]): string =>
      execFileSync('git', ['-C', proofRepo, ...argv], { encoding: 'utf8' }).trim()
    proofGit('config', 'user.email', 'shipping@test.invalid')
    proofGit('config', 'user.name', 'Shipping Test')
    writeFileSync(join(proofRepo, 'base.txt'), 'base\n')
    proofGit('add', 'base.txt')
    proofGit('commit', '-m', 'base')
    const base = proofGit('rev-parse', 'HEAD')
    proofGit('switch', '-c', 'issue/proof')
    writeFileSync(join(proofRepo, 'proof.txt'), 'proof\n')
    proofGit('add', 'proof.txt')
    proofGit('commit', '-m', 'proof')
    const head = proofGit('rev-parse', 'HEAD')
    proofGit('switch', 'main')
    const plane = new ShippingExecutionPlane(runtime, asMachineId('machine-1'))
    const common = {
      type: 'shippingJobRequest' as const,
      requestId: 'proof-binding',
      action: 'start' as const,
      orderId: asShipOrderId('proof-order'),
      attemptId: asShipAttemptId('proof-attempt'),
      generation: 1,
      shippingProtocolVersion: 2 as const,
      repoPath: proofRepo,
      repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
      sourceBranch: 'issue/proof',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: head,
      expectedTargetSha: base,
      destination: 'local:main',
      policyId: 'proof-policy',
      validationProfile: {
        id: 'proof-binding',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    for (const operation of ['preflight', 'prepare-merge-group', 'validate'] as const) {
      expect(
        plane.handle(signed({ ...common, jobId: `proof-attempt:${operation}`, operation })),
      ).toMatchObject({ state: 'succeeded' })
    }
    proofGit(
      'update-ref',
      'refs/podium/ship/other-order-proof-attempt-1-single/candidate',
      head,
    )
    const otherOrder = plane.handle(
      signed({
        ...common,
        requestId: 'other-order-commit',
        jobId: 'proof-attempt:commit-merge-group',
        orderId: asShipOrderId('other-order'),
        operation: 'commit-merge-group',
      }),
    )
    expect(otherOrder).toMatchObject({ state: 'held', classification: 'validation-failed' })
    expect(otherOrder.summary).toContain('no matching green validation proof')
    expect(proofGit('rev-parse', 'main')).toBe(base)

    execFileSync('git', ['clone', '--no-hardlinks', proofRepo, secondRepo])
    execFileSync('git', ['-C', secondRepo, 'branch', 'issue/proof', 'origin/issue/proof'])
    execFileSync('git', [
      '-C',
      secondRepo,
      'update-ref',
      'refs/podium/ship/proof-order-proof-attempt-1-single/candidate',
      head,
    ])
    const secondPlane = new ShippingExecutionPlane(secondRuntime, asMachineId('machine-1'))
    const validationRequest = signed({
      ...common,
      requestId: 'seed-validation',
      jobId: 'proof-attempt:validate',
      operation: 'validate',
    })
    const validationProof = plane.journal.get(validationRequest.jobId)?.result
    if (!validationProof) throw new Error('expected first repository validation proof')
    secondPlane.journal.begin(validationRequest, validationProof)
    const otherRepository = secondPlane.handle(
      signed({
        ...common,
        repoPath: secondRepo,
        requestId: 'other-repository-commit',
        jobId: 'proof-attempt:commit-merge-group',
        operation: 'commit-merge-group',
      }),
    )
    expect(otherRepository).toMatchObject({ state: 'held', classification: 'validation-failed' })
    expect(otherRepository.summary).toContain('no matching green validation proof')
    expect(
      execFileSync('git', ['-C', secondRepo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(),
    ).toBe(base)
  })

  it.skipIf(process.platform === 'win32')(
    'recovers an atomic completion after a server process dies across daemon RPCs',
    async () => {
      const processRepo = join(root, 'process-repo')
      const dbPath = join(root, 'process-server', 'podium.db')
      const daemonRuntime = join(root, 'process-daemon')
      resetFixture(processRepo, join(root, 'process-server'), daemonRuntime)
      execFileSync('git', ['init', '--initial-branch=main', processRepo])
      execFileSync('git', ['-C', processRepo, 'config', 'user.email', 'shipping@test.invalid'])
      execFileSync('git', ['-C', processRepo, 'config', 'user.name', 'Shipping Test'])
      writeFileSync(join(processRepo, 'base.txt'), 'base\n')
      execFileSync('git', ['-C', processRepo, 'add', 'base.txt'])
      execFileSync('git', ['-C', processRepo, 'commit', '-m', 'base'])

      const worker = join(import.meta.dirname, 'fixtures', 'server-recovery-worker.ts')
      const crashed = spawn('bun', [
        '--conditions=@podium/source',
        worker,
        'crash',
        dbPath,
        processRepo,
        daemonRuntime,
      ])
      let crashOutput = ''
      crashed.stdout.setEncoding('utf8')
      crashed.stdout.on('data', (chunk: string) => {
        crashOutput += chunk
      })
      const [code, signal] = (await once(crashed, 'close')) as [
        number | null,
        NodeJS.Signals | null,
      ]
      expect(crashOutput).toContain('completion-boundary')
      expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })

      const recoveredOutput = execFileSync(
        'bun',
        ['--conditions=@podium/source', worker, 'recover', dbPath, processRepo, daemonRuntime],
        { encoding: 'utf8' },
      )
      const recoveryLine = recoveredOutput.trim().split('\n').at(-1)
      if (!recoveryLine) throw new Error('recovery worker returned no result')
      const recovered = JSON.parse(recoveryLine)
      expect(recovered).toMatchObject({
        orderState: 'shipped',
        issueStage: 'done',
        attempt: { leaseGeneration: 1, outcome: 'succeeded', validationResult: 'passed' },
        receipt: { validationResult: 'passed' },
        staleGeneration: { generation: 0, state: 'held', classification: 'stale-generation' },
      })
    },
  )
})
