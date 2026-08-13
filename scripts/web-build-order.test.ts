import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const scripts = (
  JSON.parse(readFileSync(`${root}apps/web/package.json`, 'utf8')) as {
    scripts: Record<string, string>
  }
).scripts
const distScript = scripts['build:dist'] as string
const buildScript = scripts.build as string

/**
 * The order of the web build is load-bearing, and the failure it prevents is
 * invisible on a green build — it only shows when a later step FAILS.
 */
describe('the order of the web build', () => {
  it('stamps the dist after everything that writes to it', () => {
    // POD-1986: the stamp means "this dist is finished", so it must follow every
    // step that puts bytes in it.
    const stamp = distScript.indexOf('write-web-build-stamp')
    expect(stamp).toBeGreaterThan(-1)
    for (const writer of ['vite build', 'archive-web-sourcemaps', 'precompress-dist']) {
      expect(distScript.indexOf(writer), writer).toBeGreaterThan(-1)
      expect(distScript.indexOf(writer), `${writer} must run before the stamp`).toBeLessThan(stamp)
    }
  })

  it('judges the size only AFTER the dist has been named', () => {
    // POD-2002: web-bundle-budget writes nothing — it is a pure assertion. In
    // front of the stamp it left a complete, correct build with no
    // podium-build.json, which the server reads as "not the website for this
    // commit": it then rebuilt on every start-up, refused to pack a bundle, and
    // published no headless artifact. A size complaint must not make a good
    // build unusable; it still fails the command, which is what stops landings.
    expect(distScript).toContain('write-web-build-stamp')
    expect(distScript).not.toContain('web-bundle-budget')
    expect(buildScript).toContain('build:dist')
    expect(buildScript.indexOf('web-bundle-budget')).toBeGreaterThan(buildScript.indexOf('build:dist'))
  })

  it('still fails the build when the budget is exceeded', () => {
    // `&&`, not `;` — the check must remain able to fail the command.
    expect(buildScript).toMatch(/&&\s*bun [^&]*web-bundle-budget[^&]*--check\s*$/)
  })

  it('keeps a dest rebuild script that stops at the stamp', () => {
    // Dest rebuilds need a named website even when the landing ratchet is red.
    // `build:dist` is that script; dest dest-web-build must call it, not `build`.
    const scripts = (
      JSON.parse(readFileSync(`${root}apps/web/package.json`, 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    const dist = scripts['build:dist']
    expect(dist).toBeTruthy()
    expect(dist).toContain('write-web-build-stamp')
    expect(dist).not.toContain('web-bundle-budget')
    expect(scripts.build).toContain('build:dist')
    expect(scripts.build).toContain('web-bundle-budget')
  })
})
