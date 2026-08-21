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
  url: 'https://server.test/updates/feed/dev/artifact/x',
  digest: 'd',
  signature: 's',
}

/**
 * A dev-channel target as the resolver now stamps it: an ordinary feed artifact
 * whose SIGNATURE must be under the pinned instance key rather than the baked
 * release one. Nothing about how it travels is special any more; `trust` is the
 * only thing that distinguishes it from an edge release.
 */
const developmentTarget: UpdateGrantMessage['target'] = {
  version: '0.1.2-dev.4+abc1234',
  critical: false,
  trust: 'instance',
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: {
        'linux-x86_64': developmentBundleAsset,
      },
    },
  },
}

function deps(over: Partial<Parameters<typeof applyGrant>[1]> = {}) {
  return {
    currentVersion: () => '0.4.1',
    caps: ['update.delivery.feed'],
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

  it('replaces equal-version bytes for an explicit repair grant', async () => {
    const d = deps({ currentVersion: () => '0.4.2' })
    await applyGrant({ type: 'updateGrant', grantId: 'g-repair', repair: true, target }, d)
    expect(d.fetchArtifact).toHaveBeenCalled()
    expect(d.swap).toHaveBeenCalled()
    expect(d.writePending).toHaveBeenCalled()
    expect(d.restart).toHaveBeenCalledWith('0.4.2')
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

  /**
   * THE TRUST ROOT TRAVELS FROM THE GRANT TO DELIVERY, UNTOUCHED (spec §1).
   *
   * The daemon must not infer which key to verify against — not from the
   * version string, not from the URL, and no longer from a delivery kind. The
   * server's resolver stamped it from the channel, and this is the hand-off.
   */
  it('hands delivery the trust root the grant carried', async () => {
    const d = deps({ currentVersion: () => '0.1.2-dev.3+aaaaaaa' })
    await applyGrant({ type: 'updateGrant', grantId: 'g-installed', target: developmentTarget }, d)
    // The third argument is the supersede signal, absent for a direct apply;
    // the fourth is where delivery reports its progress (POD-2101).
    expect(d.fetchArtifact).toHaveBeenCalledWith(
      developmentBundleAsset,
      'instance',
      undefined,
      expect.any(Function),
    )
    expect(d.swap).toHaveBeenCalledOnce()
    expect(d.restart).toHaveBeenCalledOnce()
  })

  it('passes NO trust root when the target names none, rather than choosing one', async () => {
    const d = deps()
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.fetchArtifact).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      expect.any(Function),
    )
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
    // A source daemon: it reports no delivery capability at all now that git
    // delivery is retired, so a feed target is one it must refuse for itself.
    const d = deps({ caps: ['podium.shipping-train'] })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'rejected', detail: expect.stringMatching(/delivery/) }),
    )
  })

  /**
   * THE FOREGROUND ALL-IN-ONE (POD-2210). A daemon whose exit is also the
   * server's must not take delivery at all, and the operator must be told why
   * rather than watching the browser lose its server mid-update.
   */
  describe('when converging would stop a server nothing would restart', () => {
    const refusing = (over: Partial<Parameters<typeof applyGrant>[1]> = {}) =>
      deps({
        refuse: () => 'cannot converge: foreground-all-in-one — it would not come back',
        ...over,
      })

    it('touches nothing: no fetch, no swap, no marker, no exit', async () => {
      // Order matters as much as the refusal. Git delivery detaches the very
      // checkout the running server reads its assets, migrations and lifecycle
      // workers from, so a convergence stopped anywhere later would leave a live
      // old process on new source. Nothing changed is the only honest state.
      const d = refusing()
      await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
      expect(d.fetchArtifact).not.toHaveBeenCalled()
      expect(d.swap).not.toHaveBeenCalled()
      expect(d.writePending).not.toHaveBeenCalled()
      expect(d.restart).not.toHaveBeenCalled()
    })

    it('reports rejected carrying the reason, and never says downloading', async () => {
      const d = refusing()
      await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
      const frames = (d.report as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as { state: string; detail?: string },
      )
      expect(frames.map((f) => f.state)).toEqual(['rejected'])
      expect(frames[0]?.detail).toContain('foreground-all-in-one')
    })

    it('still says current when it is already on the target', async () => {
      // A refusal is about converging. A daemon that has nothing to converge has
      // nothing to refuse, and a fleet row that read `rejected` here would be a
      // lie about a machine that is up to date.
      const d = refusing({ currentVersion: () => '0.4.2' })
      await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
      expect(d.report).toHaveBeenCalledWith(expect.objectContaining({ state: 'current' }))
    })

    it('converges normally when nothing refuses', async () => {
      // The arm that proves the guard is a guard and not a general stop.
      const d = deps()
      await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
      expect(d.swap).toHaveBeenCalledOnce()
      expect(d.restart).toHaveBeenCalledOnce()
    })
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
            _trust: unknown,
            _signal?: AbortSignal,
            onProgress?: (p: { phase: string; percent?: number }) => void,
          ) => {
            // A body with no declared length: bytes arrive, and there is
            // nothing to divide them by, so no percent may be manufactured.
            onProgress?.({ phase: 'downloading' })
            return { bytes: new Uint8Array([1]) }
          },
        ),
      })
      await applyGrant({ type: 'updateGrant', grantId: 'g-unmeasured', target }, d)

      const beat = frames(d)[1]
      expect(beat).toMatchObject({ state: 'downloading', phaseDetail: 'downloading' })
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

/**
 * THE REFUSAL THAT NEEDS TO SEE THE TARGET (POD-2213).
 *
 * The foreground-all-in-one refusal is a fact about the process and needs no
 * argument. Whether a downgrade would strand this machine's database is a fact
 * about THIS target — so the seam hands the target over, and both refusals land
 * in the same place: before a byte is fetched.
 */
describe('applyGrant consults the refusal about the target itself', () => {
  const migratedTarget: UpdateGrantMessage['target'] = {
    ...(target as UpdateGrantMessage['target']),
    version: '0.1.3',
    schema: { migrations: ['20260715135845_baseline'] },
  }

  it('hands the target to the refusal', async () => {
    const refuse = vi.fn(() => undefined)
    const d = deps({ refuse })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target: migratedTarget }, d)
    expect(refuse).toHaveBeenCalledWith(migratedTarget)
  })

  it('fetches nothing when the target cannot open this machine database', async () => {
    const d = deps({
      refuse: (t: UpdateGrantMessage['target']) =>
        t.version === '0.1.3' ? 'cannot converge: schema-advanced — it would not start' : undefined,
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target: migratedTarget }, d)
    expect(d.fetchArtifact).not.toHaveBeenCalled()
    expect(d.swap).not.toHaveBeenCalled()
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'rejected',
        detail: expect.stringContaining('schema-advanced'),
      }),
    )
  })

  it('converges to a target the same machine CAN open', async () => {
    // The arm the design deliberately keeps: a downgrade whose schema did not
    // advance is a rollback, and it still happens.
    const d = deps({
      refuse: (t: UpdateGrantMessage['target']) =>
        t.version === '0.9.9' ? 'cannot converge: schema-advanced — it would not start' : undefined,
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target: migratedTarget }, d)
    expect(d.swap).toHaveBeenCalledOnce()
    expect(d.restart).toHaveBeenCalledOnce()
  })
})
