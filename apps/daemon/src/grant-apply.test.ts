import type { UpdateGrantMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { applyGrant, createGrantRunner } from './grant-apply'

const target = {
  version: '0.4.2',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url: 'https://x.test/a.tgz',
          digest: 'd',
          signature: 's',
        },
      },
    },
  },
} as never

const developmentBundleAsset = {
  url: 'https://server.test/dev-bundle',
  digest: 'd',
  signature: 's',
}

const developmentTarget: UpdateGrantMessage['target'] = {
  version: 'dev+abc1234',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'bundle',
      platforms: {
        'linux-x86_64': developmentBundleAsset,
      },
    },
    headlessAlternatives: [{ delivery: 'git', repo: '/repo/podium', sha: 'abc1234' }],
  },
}

function deps(over: Partial<Parameters<typeof applyGrant>[1]> = {}) {
  return {
    currentVersion: () => '0.4.1',
    caps: ['update.delivery.feed', 'update.delivery.bundle'],
    platform: 'linux-x86_64',
    fetchArtifact: vi.fn(async () => ({ bytes: new Uint8Array([1]) })),
    swap: vi.fn(),
    writePending: vi.fn(),
    restart: vi.fn(),
    report: vi.fn(),
    now: () => 1_000,
    ...over,
  }
}

describe('applyGrant', () => {
  it('reports current without swapping when already on the target', async () => {
    const d = deps({ currentVersion: () => '0.4.2' })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.swap).not.toHaveBeenCalled()
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'current', version: '0.4.2' }),
    )
  })

  it('writes the pending marker BEFORE restarting', async () => {
    const order: string[] = []
    const d = deps({
      writePending: vi.fn(() => void order.push('write')),
      restart: vi.fn(() => void order.push('restart')),
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(order).toEqual(['write', 'restart'])
  })

  it('keeps bundle delivery for an installed daemon when git is also offered', async () => {
    const d = deps({
      currentVersion: () => 'dev+old',
      caps: ['update.delivery.feed', 'update.delivery.bundle'],
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g-installed', target: developmentTarget }, d)
    // The third argument is the supersede signal, absent for a direct apply;
    // the fourth is where delivery reports its progress (POD-2101).
    expect(d.fetchArtifact).toHaveBeenCalledWith(
      developmentBundleAsset,
      'bundle',
      undefined,
      expect.any(Function),
    )
    expect(d.swap).toHaveBeenCalledOnce()
    expect(d.restart).toHaveBeenCalledOnce()
  })

  it('does not swap when the signature check throws', async () => {
    const d = deps({
      fetchArtifact: vi.fn(async () => {
        throw new Error('signature verification FAILED')
      }),
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.swap).not.toHaveBeenCalled()
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(expect.objectContaining({ state: 'rejected' }))
  })

  it('records the version it is rolling back TO before swapping', async () => {
    const d = deps()
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.writePending).toHaveBeenCalledWith(
      expect.objectContaining({ previousVersion: '0.4.1', targetVersion: '0.4.2', attempts: 1 }),
    )
  })

  it('reports rejected and does not restart when it cannot accept the delivery method', async () => {
    const d = deps({ caps: ['update.delivery.git'] })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'rejected', detail: expect.stringMatching(/delivery/) }),
    )
  })

  it('reports downloading before it reports restarting', async () => {
    const d = deps()
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    const states = (d.report as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { state: string }).state,
    )
    expect(states).toEqual(['downloading', 'restarting'])
  })

  /**
   * THE HEARTBEAT (POD-2101). What the daemon owes the coordinator between
   * "started" and "finished", so that nine minutes of downloading is
   * distinguishable from nine minutes of nothing.
   */
  describe('progress heartbeats', () => {
    const frames = (d: ReturnType<typeof deps>): Array<Record<string, unknown>> =>
      (d.report as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      )

    it('turns each delivery report into a frame under the same grant id', async () => {
      const d = deps({
        fetchArtifact: vi.fn(
          async (
            _asset: unknown,
            _delivery: unknown,
            _signal?: AbortSignal,
            onProgress?: (p: { phase: string; percent?: number }) => void,
          ) => {
            onProgress?.({ phase: 'downloading', percent: 20 })
            onProgress?.({ phase: 'downloading', percent: 65 })
            return { bytes: new Uint8Array([1]) }
          },
        ),
      })
      await applyGrant({ type: 'updateGrant', grantId: 'g-beat', target }, d)

      expect(frames(d)).toEqual([
        { type: 'updateStatus', grantId: 'g-beat', state: 'downloading', version: '0.4.1' },
        {
          type: 'updateStatus',
          grantId: 'g-beat',
          state: 'downloading',
          version: '0.4.1',
          percent: 20,
          phaseDetail: 'downloading',
        },
        {
          type: 'updateStatus',
          grantId: 'g-beat',
          state: 'downloading',
          version: '0.4.1',
          percent: 65,
          phaseDetail: 'downloading',
        },
        { type: 'updateStatus', grantId: 'g-beat', state: 'restarting', version: '0.4.1' },
      ])
    })

    it('names the phase without a percent when the delivery cannot measure one', async () => {
      const d = deps({
        fetchArtifact: vi.fn(
          async (
            _asset: unknown,
            _delivery: unknown,
            _signal?: AbortSignal,
            onProgress?: (p: { phase: string; percent?: number }) => void,
          ) => {
            onProgress?.({ phase: 'git-fetch' })
            return { git: true as const }
          },
        ),
      })
      await applyGrant({ type: 'updateGrant', grantId: 'g-git', target }, d)

      const beat = frames(d)[1]
      expect(beat).toMatchObject({ state: 'downloading', phaseDetail: 'git-fetch' })
      expect(beat).not.toHaveProperty('percent')
    })

    it('goes quiet once a newer grant has superseded this one', async () => {
      // A report from a superseded convergence would refresh the liveness of an
      // update nobody is waiting for any more.
      const abort = new AbortController()
      const d = deps({
        fetchArtifact: vi.fn(
          async (
            _asset: unknown,
            _delivery: unknown,
            _signal?: AbortSignal,
            onProgress?: (p: { phase: string; percent?: number }) => void,
          ) => {
            abort.abort()
            onProgress?.({ phase: 'downloading', percent: 40 })
            return { bytes: new Uint8Array([1]) }
          },
        ),
      })
      await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d, abort.signal)

      expect(frames(d).some((f) => f.percent !== undefined)).toBe(false)
    })
  })
})

/**
 * A retry after the server aged a grant out must not race the apply it replaced.
 * These cover the guarantee the deadline policy depends on: at most one grant
 * ever reaches the binary swap or the rollback marker.
 */
describe('createGrantRunner', () => {
  const grant = (grantId: string): UpdateGrantMessage => ({
    type: 'updateGrant',
    grantId,
    target,
  })

  it('ignores a repeat of the grant it is already applying', async () => {
    let release = (): void => {}
    const d = deps({
      fetchArtifact: vi.fn(
        async () =>
          await new Promise<{ bytes: Uint8Array }>((resolve) => {
            release = () => resolve({ bytes: new Uint8Array([1]) })
          }),
      ),
    })
    const runner = createGrantRunner(d)

    const first = runner.apply(grant('g1'))
    const second = runner.apply(grant('g1'))
    release()
    await Promise.all([first, second])

    expect(d.fetchArtifact).toHaveBeenCalledTimes(1)
    expect(d.swap).toHaveBeenCalledTimes(1)
    expect(d.writePending).toHaveBeenCalledTimes(1)
  })

  it('a superseded grant never swaps a binary or writes a rollback marker', async () => {
    let release = (): void => {}
    let seenSignal: AbortSignal | undefined
    const d = deps({
      fetchArtifact: vi.fn(async (_asset: unknown, _delivery: unknown, signal?: AbortSignal) => {
        if (seenSignal === undefined) {
          seenSignal = signal
          return await new Promise<{ bytes: Uint8Array }>((resolve) => {
            release = () => resolve({ bytes: new Uint8Array([1]) })
          })
        }
        return { bytes: new Uint8Array([2]) }
      }),
    })
    const runner = createGrantRunner(d)

    const first = runner.apply(grant('g1'))
    const second = runner.apply(grant('g2'))
    // The superseded delivery finishing late must change nothing.
    release()
    await Promise.all([first, second])

    expect(seenSignal?.aborted).toBe(true)
    expect(d.swap).toHaveBeenCalledTimes(1)
    expect(d.writePending).toHaveBeenCalledTimes(1)
    expect(d.writePending).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'g2' }))
  })

  it('does not report a failure for a run that was merely superseded', async () => {
    let call = 0
    const d = deps({
      // Only the FIRST delivery is superseded; it fails the way an aborted
      // fetch does, and that failure must stay silent.
      fetchArtifact: vi.fn(async () => {
        call += 1
        if (call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          throw new Error('aborted')
        }
        return { bytes: new Uint8Array([1]) }
      }),
    })
    const runner = createGrantRunner(d)

    const first = runner.apply(grant('g1'))
    const second = runner.apply(grant('g2'))
    await Promise.all([first, second])

    const states = (d.report as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { state: string }).state,
    )
    expect(states).not.toContain('rejected')
  })
})
