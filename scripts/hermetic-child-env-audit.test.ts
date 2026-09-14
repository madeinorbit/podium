import { describe, expect, it } from 'vitest'
import {
  analyzeTestSource,
  censusTestChildren,
  formatChildEnvReport,
} from './hermetic-child-env-audit'

const repoRoot = import.meta.dirname.replace(/\/scripts$/, '')

describe('hermetic child environment detector', () => {
  it('finds no unsanctioned explicit child environment in the derived test roster', () => {
    const census = censusTestChildren(repoRoot)
    expect(census.testFiles).toBeGreaterThan(2_000)
    expect(census.calls.length).toBeGreaterThan(250)
    expect(census.findings, formatChildEnvReport(census)).toEqual([])
    expect(census.calls.some((call) => call.kind === 'inherited')).toBe(true)
    expect(census.calls.some((call) => call.kind === 'helper')).toBe(true)
  })

  it('flags a curated literal on a direct child-process call', () => {
    const report = analyzeTestSource(
      'planted-curated.test.ts',
      `
        import { spawn } from 'node:child_process'
        spawn('bun', ['-e', ''], { env: { HOME: '/tmp/fake' } })
      `,
    )
    expect(report.findings).toEqual([
      expect.objectContaining({
        file: 'planted-curated.test.ts',
        api: 'spawn',
        kind: 'curated',
      }),
    ])
  })

  it('does not fire on inherited or helper-built child environments', () => {
    const report = analyzeTestSource(
      'planted-safe.test.ts',
      `
        import { spawn, execFileSync } from 'node:child_process'
        import { hermeticChildEnv } from '../test-hermetic-env'
        spawn('bun', ['-e', ''], { env: process.env })
        const options = { env: hermeticChildEnv({ HOME: '/tmp/fake' }) }
        execFileSync('true', [], options)
      `,
    )
    expect(report.findings).toEqual([])
    expect(report.calls.map((call) => call.kind)).toEqual(['inherited', 'helper'])
  })

  it('proves the clean result is load-bearing by breaking and restoring a real shape', () => {
    const safe = `
      import { spawn } from 'node:child_process'
      import { hermeticChildEnv } from '../test-hermetic-env'
      spawn('bun', ['-e', ''], { env: hermeticChildEnv({ HOME: '/tmp/fake' }) })
    `
    const broken = safe.replace('hermeticChildEnv({', '{')
    expect(analyzeTestSource('planted-break.test.ts', broken).findings).toHaveLength(1)
    expect(analyzeTestSource('planted-break.test.ts', safe).findings).toEqual([])
  })
})
