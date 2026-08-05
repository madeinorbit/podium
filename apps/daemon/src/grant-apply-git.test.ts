import type { UpdateGrantMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { applyGrant, type GrantApplyDeps } from './grant-apply'

const grant: UpdateGrantMessage = {
  type: 'updateGrant',
  grantId: 'git-grant',
  target: {
    version: 'dev+target',
    critical: false,
    artifacts: {
      headless: {
        delivery: 'git',
        repo: '/repo/podium',
        sha: '0123456789abcdef',
      },
    },
  },
}

describe('applyGrant git delivery', () => {
  it('accepts a granted checkout and preserves marker-before-restart ordering', async () => {
    const order: string[] = []
    const fetchArtifact = vi.fn(async () => ({ git: true as const }))
    const deps: GrantApplyDeps = {
      currentVersion: () => 'dev',
      caps: ['update.delivery.git'],
      platform: 'linux-x86_64',
      fetchArtifact,
      swap: vi.fn(),
      writePending: vi.fn(() => order.push('write')),
      restart: vi.fn(() => order.push('restart')),
      report: vi.fn(),
      now: () => 1_000,
    }

    await applyGrant(grant, deps)

    expect(fetchArtifact).toHaveBeenCalledWith(grant.target.artifacts.headless, 'git')
    expect(deps.swap).not.toHaveBeenCalled()
    expect(order).toEqual(['write', 'restart'])
    expect(deps.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'restarting', grantId: 'git-grant' }),
    )
  })
})
