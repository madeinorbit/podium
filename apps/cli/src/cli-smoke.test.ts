import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Shared real-binary smoke across the podium CLIs (repo norm: skip-if-absent —
// see docs/agents/testing.md). Drives the actual runnable entry (scripts/cli.ts,
// the composition root; apps/cli/src/cli.ts only exports main) with bun, so it
// catches wiring the argv-shape unit tests (which run against an injected
// client) cannot: help must render without a server, and an unknown subcommand
// must exit non-zero. Per-verb argv parsing/validation lives in each
// <verb>-cli.test.ts.
const cliEntry = join(__dirname, '../../../scripts/cli.ts')
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return existsSync(cliEntry)
  } catch {
    return false
  }
})()

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasBun)('podium CLI real-binary smoke', () => {
  for (const verb of ['mail', 'agent', 'session']) {
    it(`${verb} --help renders without a server`, () => {
      const out = execFileSync('bun', [cliEntry, verb, '--help'], { encoding: 'utf8' })
      expect(out).toContain(verb)
      expect(out.length).toBeGreaterThan(20)
    })

    it(`${verb} fails fast on an unknown subcommand`, () => {
      expect(() =>
        execFileSync('bun', [cliEntry, verb, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
      ).toThrow()
    })
  }
})
