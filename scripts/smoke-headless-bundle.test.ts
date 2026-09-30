import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveStateFreeInformationalPlan } from '../apps/cli/src/cli'

/** A stateful probe must prove that retired executable materialization is gone. */
const PROBES = [{ file: 'smoke-headless-bundle.sh', binary: '"$HOME_DIR/podium"' }] as const

describe.each(PROBES)('$file materialization probe', ({ file, binary }) => {
  const script = readFileSync(join(import.meta.dirname, file), 'utf8')

  /** The argv the script hands the bundle for the materialization probe. */
  function probeArgv(): string[] {
    const line = script
      .split('\n')
      .find((l) => l.includes(binary) && l.includes('>/dev/null'))
    expect(line, 'the materialization probe invocation is still recognisable').toBeDefined()
    const after = (line as string).split(binary)[1] ?? ''
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

  it('asserts no abduco executable is materialized', () => {
    expect(script).toMatch(/\[ ! -e "\$STATE\/bin\/abduco" \]/)
  })
})

/**
 * THE SMOKE RUNS THE HOST THE BUNDLE SHIPS. The Rust process host is not embedded: it is a
 * separate file beside podium-cli, cross-built on its own, so it can be the wrong
 * architecture or libc while podium-cli starts fine.
 */
describe('smoke-headless-bundle.sh host checks', () => {
  const script = readFileSync(join(import.meta.dirname, 'smoke-headless-bundle.sh'), 'utf8')

  it('runs the podium-host shipped in the bundle, not a materialized copy', () => {
    expect(script).toMatch(/HOST_HELPER="\$HOME_DIR\/podium-host"/)
    expect(script).toMatch(/no executable headless\/podium-host in the bundle/)
    expect(script).toMatch(/is the retired C host \(features=1\)/)
  })

  it('asserts the host hosts a session, not only that it runs', () => {
    expect(script).toMatch(/podium-host hosts a detached session that outlived its starter/)
    expect(script).toMatch(/want 3 \(already running\)/)
  })
})
