import { execFileSync } from 'node:child_process'
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
      jobId: 'attempt-1:compatibility-land',
      orderId: asShipOrderId('order-1'),
      attemptId: asShipAttemptId('attempt-1'),
      generation: 1,
      operation: 'compatibility-land' as const,
      repoPath: repo,
      sourceBranch: 'issue/1',
      targetBranch: 'main',
      approvedBaseSha: base,
      approvedHeadSha: head,
      expectedTargetSha: base,
      destination: 'local:main',
    }
    const first = new ShippingExecutionPlane(journal, asMachineId('machine-1')).handle(common)
    expect(first).toMatchObject({ state: 'held', classification: 'unsupported-destination-effect' })
    expect(git('rev-parse', 'main')).toBe(base)
    expect(git('rev-parse', 'issue/1')).toBe(head)

    const recovered = new ShippingExecutionPlane(journal, asMachineId('machine-1'))
    expect(recovered.handle({ ...common, requestId: 'request-2', action: 'status' })).toEqual(first)
    expect(
      recovered.handle({
        ...common,
        requestId: 'request-new-generation',
        jobId: 'attempt-2:preflight',
        attemptId: asShipAttemptId('attempt-2'),
        generation: 2,
        operation: 'preflight',
      }),
    ).toMatchObject({ state: 'succeeded', classification: 'observed', generation: 2 })
    expect(
      recovered.handle({ ...common, requestId: 'request-3', action: 'status' }),
    ).toMatchObject({ state: 'held', classification: 'stale-generation' })
  })
})
