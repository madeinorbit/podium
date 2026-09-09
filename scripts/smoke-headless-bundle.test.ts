import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveStateFreeInformationalPlan } from '../apps/cli/src/cli'

/**
 * THE SMOKE'S SECOND STEP CAN ONLY WORK FROM BEHIND THE STATE CLAIM [POD-3274].
 *
 * A compiled binary materializes its embedded abduco in `afterInstanceStateClaim`
 * (scripts/cli-compiled.ts). Since "keep diagnostics state-free" (d1f21b79) `--version` is
 * answered before that claim — on purpose, so asking a binary its version cannot create a
 * state root. The smoke went on probing with `--version`, so it asserted that a command
 * designed to write nothing had written something, and every headless release since has
 * failed there. Nothing else could have caught it: the release job is the only place this
 * script runs, and an earlier step was failing first and masking it.
 *
 * So the invariant is pinned here, where it is cheap, rather than discovered in CI.
 */
describe('smoke-headless-bundle abduco probe', () => {
  const script = readFileSync(join(import.meta.dirname, 'smoke-headless-bundle.sh'), 'utf8')

  /** The argv the script hands the bundle for the materialization probe. */
  function probeArgv(): string[] {
    const line = script
      .split('\n')
      .find((l) => l.includes('"$HOME_DIR/podium"') && l.includes('>/dev/null'))
    expect(line, 'the materialization probe invocation is still recognisable').toBeDefined()
    const after = (line as string).split('"$HOME_DIR/podium"')[1] ?? ''
    return after
      .split('>')[0]!
      .trim()
      .split(/\s+/)
      .filter((a) => a !== '')
  }

  it('probes with a command that reaches the instance state claim', () => {
    const argv = probeArgv()
    expect(argv.length).toBeGreaterThan(0)
    expect(resolveStateFreeInformationalPlan(argv)).toBeUndefined()
  })

  it('still asserts the helper materialized, rather than merely running the bundle', () => {
    expect(script).toContain('did not materialize an executable abduco')
  })
})
