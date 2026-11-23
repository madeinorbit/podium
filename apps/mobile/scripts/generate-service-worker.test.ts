// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generatePhoneServiceWorker } from './generate-service-worker'

/**
 * The phone's worker (POD-7179), generated over a small export shaped like
 * Metro's: the page, a hashed entry chunk, a package font under a dot directory
 * inside `node_modules`, and the files that must stay out of the precache.
 */
const FONT = 'assets/__node_modules/.bun/geist@0.4.2/node_modules/geist/Geist.0123456789abcdef.ttf'
const IMAGE = 'assets/node_modules/expo-router/assets/arrow_down.0123456789abcdef.png'

let dist: string
let sw: string

function put(path: string, body: string): void {
  mkdirSync(dirname(join(dist, path)), { recursive: true })
  writeFileSync(join(dist, path), body)
}

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'podium-phone-sw-'))
  put(
    'index.html',
    '<!doctype html><title>Podium</title><script src="/mobile/_expo/static/js/web/entry-0123456789abcdef.js"></script>',
  )
  put('_expo/static/js/web/entry-0123456789abcdef.js', 'console.log("entry")')
  put('_expo/static/css/xterm-0123456789abcdef.css', 'body{}')
  put(FONT, 'font')
  put(IMAGE, 'image')
  put('manifest.webmanifest', '{"start_url":"/mobile"}')
  put('podium-build.json', '{"appVersion":"0.1.0"}')
  put('index.html.br', 'compressed')
  await generatePhoneServiceWorker(dist)
  sw = readFileSync(join(dist, 'sw.js'), 'utf8')
}, 120_000)

afterAll(() => rmSync(dist, { recursive: true, force: true }))

describe('the phone service worker', () => {
  it('precaches the page, its chunks, styles and package assets, dot directories too', () => {
    expect(sw).toContain('url:"index.html"')
    expect(sw).toContain('_expo/static/js/web/entry-0123456789abcdef.js')
    expect(sw).toContain('_expo/static/css/xterm-0123456789abcdef.css')
    expect(sw).toContain(`url:"${FONT}"`)
    expect(sw).toContain(`url:"${IMAGE}"`)
    expect(sw).toContain('manifest.webmanifest')
  })

  it('never precaches the build stamp, or compressed copies', () => {
    expect(sw).not.toContain('podium-build.json')
    expect(sw).not.toContain('.br"')
  })

  it('answers every /mobile navigation with the precached page', () => {
    expect(sw).toContain('"/mobile/index.html"')
    expect(sw).toContain(String.raw`allowlist:[/^\/mobile(\/|\?|$)/]`)
  })

  it('waits for the handshake: it takes over on SKIP_WAITING, not by itself', () => {
    // The one skipWaiting is the message handler's: none runs on install.
    expect(sw.match(/self\.skipWaiting\(\)/g)).toHaveLength(1)
    expect(sw).toMatch(/"SKIP_WAITING"===\w+\.data\.type&&self\.skipWaiting\(\)/)
    expect(sw).toContain('self.clients.claim()')
  })

  it('is one self-contained file with no source map', () => {
    expect(sw).not.toContain('importScripts(')
    expect(sw).not.toContain('sourceMappingURL')
  })

  // scripts/write-web-build-stamp.ts rewrites exactly this entry's revision
  // (SW_INDEX_PRECACHE_ENTRY), and throws on any count but one. That module
  // does not load under this lane's resolution, so its shape is checked here.
  it('has the one index.html entry the build stamp rewrites', () => {
    expect(sw.match(/\{url:"index\.html",revision:"[0-9a-f]{32}"\}/g)).toHaveLength(1)
  })
})
