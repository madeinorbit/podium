import type { UpdateGrantMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { applyGrant } from './grant-apply'

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
    expect(d.fetchArtifact).toHaveBeenCalledWith(developmentBundleAsset, 'bundle')
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
})
