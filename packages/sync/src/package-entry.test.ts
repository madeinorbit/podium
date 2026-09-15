import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describeSyncConformance, describeStoreFidelity } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'

describe('sync package entries', () => {
  it('loads the production entry in a fresh Bun process without a test runner', () => {
    const output = execFileSync(
      'bun',
      [
        '--conditions=@podium/source',
        '-e',
        `const sync = await import('@podium/sync');
console.log(JSON.stringify({
  authority: typeof sync.Authority,
  policy: typeof sync.GrantEdgeVisibilityPolicy,
  conformance: 'describeSyncConformance' in sync,
  fidelity: 'describeStoreFidelity' in sync,
}));`,
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 },
    )
    expect(JSON.parse(output)).toEqual({
      authority: 'function',
      policy: 'function',
      conformance: false,
      fidelity: false,
    })
  })

  it('exposes the conformance suites through the testing entry', () => {
    expect(typeof describeSyncConformance).toBe('function')
    expect(typeof describeStoreFidelity).toBe('function')
  })
})
