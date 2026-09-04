import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const scripts = (
  JSON.parse(readFileSync(`${root}apps/web/package.json`, 'utf8')) as {
    scripts: Record<string, string>
  }
).scripts
const buildScript = scripts.build as string
/** The `&&`-separated steps of `build`, in order. */
const steps = buildScript.split('&&').map((step) => step.trim())
/** The steps that WRITE into dist — everything up to and including the stamp. */
const writingSteps = buildScript.slice(
  0,
  buildScript.indexOf('write-web-build-stamp') + 'write-web-build-stamp'.length,
)

/**
 * The order of the web build is load-bearing, and the failure it prevents is
 * invisible on a green build — it only shows when a later step FAILS.
 */
describe('the order of the web build', () => {
  it('stamps the dist after everything that writes to it', () => {
    // POD-1986: the stamp means "this dist is finished", so it must follow every
    // step that puts bytes in it.
    const stamp = buildScript.indexOf('write-web-build-stamp')
    expect(stamp).toBeGreaterThan(-1)
    for (const writer of ['vite build', 'archive-web-sourcemaps', 'precompress-dist']) {
      expect(buildScript.indexOf(writer), writer).toBeGreaterThan(-1)
      expect(buildScript.indexOf(writer), `${writer} must run before the stamp`).toBeLessThan(stamp)
    }
  })

  it('judges the size only AFTER the dist has been named', () => {
    // POD-2002: web-bundle-budget writes nothing — it is a pure assertion. In
    // front of the stamp it left a complete, correct build with no
    // podium-build.json, which the server reads as "not the website for this
    // commit": it then rebuilt on every start-up, refused to pack a bundle, and
    // published no headless artifact. A size complaint must not make a good
    // build unusable; it still fails the command, which is what stops landings.
    expect(writingSteps).toContain('write-web-build-stamp')
    expect(writingSteps).not.toContain('web-bundle-budget')
    expect(buildScript.indexOf('web-bundle-budget')).toBeGreaterThan(
      buildScript.indexOf('write-web-build-stamp'),
    )
  })

  it('still fails the build when the budget is exceeded', () => {
    // `&&`, not `;` — the check must remain able to fail the command.
    expect(buildScript).toMatch(/&&\s*bun [^&]*web-bundle-budget[^&]*--check\s*$/)
  })

  it('is the only production recipe, so no caller can skip the ratchet', () => {
    // POD-3053: `build:dist` existed so a dest rebuild could stop before the
    // landing size ratchet. Two recipes meant dev and a release could ship
    // different bytes from one commit, and the exemption quietly became the
    // normal path. There is now one script, it is the Turbo task, and a red
    // ratchet is a red build for everyone — the floor is raised in
    // scripts/web-bundle-budget.ts, not routed around here.
    expect(scripts['build:dist']).toBeUndefined()
    expect(steps.at(-1)).toContain('web-bundle-budget')
    expect(steps.at(-2)).toContain('write-web-build-stamp')
  })
})
