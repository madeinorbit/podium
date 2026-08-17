/**
 * THE GATE THAT FIRES FOR A BUNDLE THAT PREDATES EVERY CLIENT-SIDE CHECK (POD-1610).
 *
 * Both directions are pinned, and the negative one matters most: a skew detector
 * that fires on a healthy pair is worse than none, because the first thing people
 * do with a banner they have seen on a working system is stop reading banners.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_STAMP_FILE, wireSchemaDigest } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  describeBundle,
  gradeWebBundle,
  injectBundleWarning,
  readWebBuildStamp,
  servedWebIdentity,
  servedWebSourceDigest,
} from './web-bundle-stamp'

let dir: string

const stamp = (body: unknown) =>
  writeFileSync(join(dir, BUILD_STAMP_FILE), JSON.stringify(body), 'utf8')
const buildDist = () => writeFileSync(join(dir, 'index.html'), '<html><body>app</body></html>')

beforeEach(() => {
  // A fresh directory per case: `gradeWebBundle` caches its verdict per webDir on
  // the stamp's mtime, and mtime resolution is coarse enough that two writes in
  // one millisecond would serve the first case's answer to the second.
  dir = mkdtempSync(join(tmpdir(), 'podium-dist-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('grading a served dist', () => {
  it('CAN SAY NO: a matched pair is ok and says nothing', () => {
    buildDist()
    stamp({ wireSchemaDigest: wireSchemaDigest(), wireVersion: 2, builtAt: '2026-08-03T00:00:00Z' })
    const status = gradeWebBundle(dir)
    expect(status.grade).toBe('ok')
    expect(describeBundle(status)).toBeNull()
    expect(injectBundleWarning('<html><body>app</body></html>', status)).toBe(
      '<html><body>app</body></html>',
    )
  })

  it('calls a mismatched pair stale and gives the user a recovery action', () => {
    buildDist()
    stamp({ wireSchemaDigest: 'deadbeefdeadbeef', builtAt: '2026-07-31T23:17:00Z' })
    const status = gradeWebBundle(dir)
    expect(status.grade).toBe('stale')
    expect(status.bundleDigest).toBe('deadbeefdeadbeef')
    expect(status.serverDigest).toBe(wireSchemaDigest())
    const message = describeBundle(status) ?? ''
    expect(message).toContain('different app builds')
    expect(message).toContain('Repair and reload')
    expect(message).not.toContain('bun run')
    expect(message).not.toContain('deadbeef')
  })

  it('refuses to certify a dist with NO stamp — the pre-fix artefact', () => {
    // The case the whole gate exists for: a dist built before any of this shipped
    // cannot be checked, and "cannot be checked" must not read as "fine".
    buildDist()
    expect(gradeWebBundle(dir).grade).toBe('unstamped')
    expect(describeBundle(gradeWebBundle(dir))).toContain('cannot verify')
  })

  it('treats a corrupt stamp as unstamped, never as ok', () => {
    buildDist()
    writeFileSync(join(dir, BUILD_STAMP_FILE), '{ not json', 'utf8')
    expect(gradeWebBundle(dir).grade).toBe('unstamped')
  })

  it('treats a stamp with no digest field as unstamped', () => {
    buildDist()
    stamp({ builtAt: '2026-08-03T00:00:00Z' })
    expect(gradeWebBundle(dir).grade).toBe('unstamped')
  })

  it('says nothing at all when there is no dist — a source run is not a defect', () => {
    const status = gradeWebBundle(dir)
    expect(status.grade).toBe('absent')
    expect(describeBundle(status)).toBeNull()
  })

  it('reads the source SHA without letting it change the compatibility grade', () => {
    buildDist()
    stamp({
      wireSchemaDigest: wireSchemaDigest(),
      sourceSha: '47a01e3',
      appVersion: 'dev+47a01e3',
    })
    expect(gradeWebBundle(dir).grade).toBe('ok')
    expect(servedWebSourceDigest(dir)).toBe('47a01e3')
    expect(readWebBuildStamp(dir)?.appVersion).toBe('dev+47a01e3')

    stamp({
      wireSchemaDigest: wireSchemaDigest(),
      sourceSha: 'aaaaaaa',
      appVersion: 'dev+aaaaaaa',
    })
    expect(gradeWebBundle(dir).grade).toBe('ok')
    expect(servedWebSourceDigest(dir)).toBe('aaaaaaa')
  })

  it('re-grades when the stamp changes under a running server', () => {
    buildDist()
    stamp({ wireSchemaDigest: 'deadbeefdeadbeef' })
    expect(gradeWebBundle(dir).grade).toBe('stale')
    // A rebuild while the server runs must clear the warning without a restart.
    stamp({ wireSchemaDigest: wireSchemaDigest(), builtAt: '2026-08-03T12:00:00Z' })
    expect(gradeWebBundle(dir).grade).toBe('ok')
  })
})

/**
 * ABSENT AND UNSTAMPED SHARE ONE `undefined` DIGEST AND NEED OPPOSITE VERDICTS
 * (POD-1980). This is the whole reason Update is told about a dist's PRESENCE
 * and not only about its checkout.
 */
describe('what a served website says about its checkout', () => {
  it('reports the checkout of a stamped dist', () => {
    buildDist()
    stamp({ wireSchemaDigest: wireSchemaDigest(), sourceSha: '47a01e3' })
    expect(servedWebIdentity(dir)).toEqual({
      present: true,
      appVersion: 'dev+47a01e3',
      digest: '47a01e3',
    })
  })

  it('reports a dist that is there and names no checkout as present, not missing', () => {
    buildDist()
    expect(servedWebIdentity(dir)).toEqual({ present: true })
  })

  it('reports no website when nothing was ever built here', () => {
    expect(servedWebIdentity(dir)).toEqual({ present: false })
    expect(servedWebIdentity('')).toEqual({ present: false })
  })

  it('CAN SAY NO: a stamp that is not a checkout at all names no digest', () => {
    buildDist()
    stamp({ wireSchemaDigest: wireSchemaDigest(), sourceSha: 'not-a-sha' })
    expect(servedWebIdentity(dir)).toEqual({ present: true })
  })

  it('sees a website that appeared after the server booted', () => {
    expect(servedWebIdentity(dir).present).toBe(false)
    buildDist()
    stamp({ wireSchemaDigest: wireSchemaDigest(), sourceSha: '47a01e3' })
    // The phone export is built by a separate unit that can finish long after
    // boot, so this must be a live probe rather than a captured flag.
    expect(servedWebIdentity(dir)).toEqual({
      present: true,
      appVersion: 'dev+47a01e3',
      digest: '47a01e3',
    })
  })
})

describe('the warning reaches a bundle that cannot warn about itself', () => {
  const stale = {
    grade: 'stale' as const,
    bundleDigest: 'deadbeefdeadbeef',
    serverDigest: wireSchemaDigest(),
  }

  it('injects visible markup before </body>', () => {
    const html = injectBundleWarning('<html><body><div id="root"></div></body></html>', stale)
    expect(html).toContain('role="alert"')
    expect(html).toContain('needs to finish updating')
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('</body>'))
  })

  it('appends when there is no </body> to find', () => {
    expect(injectBundleWarning('<div id="root"></div>', stale)).toContain('role="alert"')
  })

  it('escapes what it read off disk — a file is never markup', () => {
    const html = injectBundleWarning('<html><body></body></html>', {
      ...stale,
      bundleDigest: '<script>alert(1)</script>',
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)')
  })
})
