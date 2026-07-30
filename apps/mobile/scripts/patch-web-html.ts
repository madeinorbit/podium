/**
 * Post-export patch for the web build (runs after `expo export -p web`).
 *
 * Expo's `single` (SPA) output ignores app/+html.tsx, so the generated
 * index.html ships the stock viewport meta. iOS Safari auto-zooms any focused
 * input under 16px — the app's dense type is 12–13px — and stays zoomed,
 * cutting off the next screen. `maximum-scale=1` suppresses that input
 * auto-zoom (Safari still honours user pinch gestures, so no accessibility
 * cost); `viewport-fit=cover` exposes the safe-area env() insets.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const file = join(import.meta.dir, '..', 'dist', 'index.html')
const html = readFileSync(file, 'utf8')
const viewport =
  'width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no, viewport-fit=cover'
const patched = html.replace(
  /<meta name="viewport" content="[^"]*"/,
  `<meta name="viewport" content="${viewport}"`,
)
if (patched === html) throw new Error('patch-web-html: viewport meta not found in dist/index.html')
writeFileSync(file, patched)
console.log('patched viewport meta in dist/index.html')
