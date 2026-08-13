import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asShipAttemptId, asShipOrderId } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import { ShippingExecutionPlane } from './executor'

const root = mkdtempSync(join(tmpdir(), 'podium-shipping-restart-'))
const repo = join(root, 'repo')
const journal = join(root, 'runtime')

const git = (...argv: string[]): string =>
  execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8' }).trim()

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('shipping daemon restart recovery', () => {
  it('proves or holds without mutating refs and resumes from its journal', () => {
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
      repoPath: repo,
      sourceBranch: 'issue/1',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: head,
      expectedTargetSha: base,
      destination: 'local:main',
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
      const request = {
        ...common,
        requestId: `request-${operation}`,
        jobId: `attempt-1:${operation}`,
        operation,
      }
      // Crash boundary one: the durable start exists but the process died before
      // recording a terminal result. A fresh executor must observe/replay it.
      plane.journal.begin(request, {
        jobId: request.jobId,
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
      expect(result.state).toBe('succeeded')
      if (operation !== 'preflight') {
        expect(result).toMatchObject({ testedIntegrationSha: head })
      }
      // Crash boundary three: terminal daemon proof exists but no server ack.
      // Both status and duplicate start return byte-for-byte stable evidence.
      const afterTerminalRestart = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
      expect(
        afterTerminalRestart.handle({ ...request, requestId: `${request.requestId}-status`, action: 'status' }),
      ).toEqual(result)
      expect(
        afterTerminalRestart.handle({ ...request, requestId: `${request.requestId}-replay` }),
      ).toEqual(result)
      if (operation === 'preflight' || operation === 'prepare-merge-group' || operation === 'validate') {
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
      recovered.handle({
        ...common,
        requestId: 'request-new-generation',
        jobId: 'attempt-2:preflight',
        attemptId: asShipAttemptId('attempt-2'),
        generation: 2,
        operation: 'preflight',
        expectedTargetSha: head,
      }),
    ).toMatchObject({ state: 'succeeded', classification: 'observed', generation: 2 })
    expect(recovered.handle({ ...common, requestId: 'request-3', action: 'status' })).toMatchObject(
      { state: 'held', classification: 'stale-generation' },
    )
  })

  it('publishes the exact tested commit through the non-force remote adapter', () => {
    const remoteRepo = join(root, 'remote-repo')
    const bare = join(root, 'destination.git')
    const runtime = join(root, 'remote-runtime')
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
      repoPath: remoteRepo,
      sourceBranch: 'issue/remote',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: head,
      expectedTargetSha: base,
      destination: 'git:origin/main',
      validationProfile: {
        id: 'remote-proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    for (const operation of [
      'preflight',
      'prepare-merge-group',
      'validate',
      'commit-merge-group',
      'publish',
      'verify',
    ] as const) {
      expect(
        plane.handle({ ...common, jobId: `remote-attempt:${operation}`, operation }),
      ).toMatchObject({ state: 'succeeded' })
    }
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe(head)
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

    const result = new ShippingExecutionPlane(runtime, asMachineId('machine-1')).handle({
      type: 'shippingJobRequest',
      requestId: 'adoption-request',
      action: 'start',
      jobId: 'adoption-attempt:preflight',
      orderId: asShipOrderId('adoption-order'),
      attemptId: asShipAttemptId('adoption-attempt'),
      generation: 1,
      operation: 'preflight',
      repoPath: adoptionRepo,
      sourceBranch: 'issue/adoption',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: base,
      expectedTargetSha: base,
      destination: 'local:main',
      validationProfile: {
        id: 'adoption-proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root',
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    })
    expect(result).toMatchObject({ state: 'succeeded', classification: 'observed' })
    const mainOwner = adoptionGit('worktree', 'list', '--porcelain')
      .split(/\n\n+/)
      .find((entry) => entry.includes('branch refs/heads/main'))
    expect(mainOwner).toContain(join(runtime, 'landing-checkouts'))
  })

  it.skipIf(process.platform === 'win32')(
    'recovers an atomic completion after a server process dies across daemon RPCs',
    async () => {
      const processRepo = join(root, 'process-repo')
      const dbPath = join(root, 'process-server', 'podium.db')
      const daemonRuntime = join(root, 'process-daemon')
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
