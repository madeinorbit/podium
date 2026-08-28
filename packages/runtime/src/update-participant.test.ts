import type { UpdateGrantMessage, UpdateStatusMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { applyGrant, type GrantApplyDeps } from './update-participant'

/**
 * A GRANT MUST ALWAYS PRODUCE AN ANSWER.
 *
 * The coordinator marks a machine `granted` the moment it hands the grant over
 * and has no other way to learn what happened: the only thing that moves that
 * place again is a status report from the participant. So a participant that
 * throws before its first report leaves the wave holding a machine that is
 * neither working nor failed, and the machines step waits out its whole silence
 * budget — the daemon's download timeout plus two minutes — before anything
 * says so. Observed as `machines=running[source:granted, schema-control:pending]`
 * on a refusal that should have taken seconds (POD-2741).
 */
const target: UpdateGrantMessage['target'] = {
  version: '9.9.9',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url: 'http://example.invalid/podium.tar.gz',
          size: 1,
          digest: 'sha256:abc',
        },
      },
    },
  },
} as unknown as UpdateGrantMessage['target']

const grant: UpdateGrantMessage = {
  type: 'updateGrant',
  grantId: 'grant_1',
  target,
}

function deps(overrides: Partial<GrantApplyDeps> = {}): {
  deps: GrantApplyDeps
  reports: UpdateStatusMessage[]
} {
  const reports: UpdateStatusMessage[] = []
  return {
    reports,
    deps: {
      currentVersion: () => '1.0.0',
      caps: ['update.delivery.feed'],
      platform: 'linux-x86_64',
      installTarget: async () => ({}),
      writePending: () => {},
      restart: () => {},
      report: (status) => reports.push(status),
      now: () => 0,
      ...overrides,
    },
  }
}

describe('applyGrant never leaves a grant unanswered', () => {
  /**
   * `refuse` is the daemon's schema gate (apps/daemon/src/host-runtime.ts). It
   * is asked BEFORE the try/catch, and the schema-refusal control deliberately
   * feeds it a manifest whose migration list has been mutated — precisely the
   * input most likely to make it throw rather than return a refusal string.
   */
  it('reports a refusal when the schema gate throws instead of answering', async () => {
    const { deps: d, reports } = deps({
      refuse: () => {
        throw new Error('migration ledger unreadable')
      },
    })

    await expect(applyGrant(grant, d)).resolves.toBeUndefined()

    expect(reports.map((report) => report.state)).toEqual(['rejected'])
    expect(reports[0]?.detail).toContain('migration ledger unreadable')
  })

  /** The same hole, one call earlier: planning is outside the try as well. */
  it('reports a refusal when reading the current version throws', async () => {
    const { deps: d, reports } = deps({
      currentVersion: () => {
        throw new Error('install VERSION unreadable')
      },
    })

    await expect(applyGrant(grant, d)).resolves.toBeUndefined()

    expect(reports.map((report) => report.state)).toEqual(['rejected'])
    expect(reports[0]?.detail).toContain('install VERSION unreadable')
  })

  /** The ordinary refusal path is unchanged: a gate that ANSWERS still answers. */
  it('still reports the refusal a gate returns', async () => {
    const { deps: d, reports } = deps({ refuse: () => 'target schema is behind this install' })

    await applyGrant(grant, d)

    expect(reports.map((report) => report.state)).toEqual(['rejected'])
    expect(reports[0]?.detail).toBe('target schema is behind this install')
  })

  /** And a healthy grant still reports its progress in order. */
  it('still reports downloading then restarting on a healthy grant', async () => {
    const restart = vi.fn()
    const { deps: d, reports } = deps({ restart })

    await applyGrant(grant, d)

    expect(reports.map((report) => report.state)).toEqual(['downloading', 'restarting'])
    expect(restart).toHaveBeenCalledOnce()
  })
})
