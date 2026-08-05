import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Tripwire on the shipped export [POD-402].
 *
 * `bun run build:web` exports and then patches; `expo export -p web` on its own
 * exports and stops. The second produces a dist that looks completely fine in a
 * browser and is broken in the one way nobody checks in a browser: Add to Home
 * Screen falls back to a Safari bookmark named after app.json's `name`, with a
 * screenshot of the page instead of the icon. That is exactly how the live dist
 * regressed, and it survived because nothing ever asserted on it.
 *
 * dist/ is gitignored, so the assertions are skipped when there is no export to
 * check — this guards a build, it does not demand one.
 */
const dist = join(import.meta.dirname, '..', 'dist')
const index = join(dist, 'index.html')

describe.skipIf(!existsSync(index))('the exported dist installs as an app', () => {
  const html = () => readFileSync(index, 'utf8')

  it('ran scripts/patch-web-html.ts', () => {
    // The marker the patch script itself looks for to stay idempotent.
    expect(html()).toContain('<style id="podium-shell">')
  })

  it('names the manifest and the touch icon, and ships both', () => {
    expect(html()).toContain('rel="manifest"')
    expect(html()).toContain('rel="apple-touch-icon"')
    // Linking files an export did not copy fails the same way as not linking.
    expect(existsSync(join(dist, 'manifest.webmanifest'))).toBe(true)
    expect(existsSync(join(dist, 'icons', 'apple-touch-icon.png'))).toBe(true)
  })

  it('installs as "Podium", not as the Expo project name', () => {
    // iOS prefills the Add to Home Screen field from this meta, falling back to
    // <title> — which app.json makes "Podium Mobile".
    expect(html()).toContain('<meta name="apple-mobile-web-app-title" content="Podium" />')
  })

  it('exposes the safe-area insets to the layout', () => {
    // Without viewport-fit=cover every env(safe-area-inset-*) resolves to 0 and
    // the chrome sits under the notch and the home indicator.
    expect(html()).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/)
  })
})
