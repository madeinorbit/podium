import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE SMOKE RUNS THE HOST THE BUNDLE SHIPS.
 *
 * The compiled binary embeds nothing any more (POD-4986): the Rust process host is a
 * separate file beside podium-cli, cross-built on its own, so it can be the wrong
 * architecture or libc while podium-cli starts fine. The smoke used to wait for an
 * embedded abduco and C podium-host to materialize behind the instance state claim
 * (POD-3274); what it must prove now is that the bundled podium-host-rs itself runs
 * here and hosts a session that outlives its starter.
 */
describe('smoke-headless-bundle.sh host checks', () => {
  const script = readFileSync(join(import.meta.dirname, 'smoke-headless-bundle.sh'), 'utf8')

  it('runs the podium-host-rs shipped in the bundle, not a materialized copy', () => {
    expect(script).toMatch(/HOST_HELPER="\$HOME_DIR\/podium-host-rs"/)
    expect(script).toMatch(/no executable headless\/podium-host-rs in the bundle/)
    expect(script).not.toMatch(/\$STATE\/bin/)
  })

  it('asserts the host hosts a session, not only that it runs', () => {
    expect(script).toMatch(/podium-host-rs hosts a detached session that outlived its starter/)
    expect(script).toMatch(/want 3 \(already running\)/)
  })

  it('probes no retired helper', () => {
    expect(script).not.toMatch(/abduco/i)
  })
})
