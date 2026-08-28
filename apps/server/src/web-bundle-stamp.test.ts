/**
 * The server keeps grading the served bundle as an operator diagnostic, while
 * the static route must return index.html without turning that grade into UI.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_STAMP_FILE, wireSchemaDigest } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  describeBundleDiagnostic,
  gradeWebBundle,
  readWebBuildStamp,
  servedWebIdentity,
  servedWebSourceDigest,
} from './web-bundle-stamp'
import { registerDesktopWebStatic } from './static-web'

let dir: string

const INDEX_HTML = '<html><body><div id="root">app</div></body></html>'
const stamp = (body: unknown) =>
  writeFileSync(join(dir, BUILD_STAMP_FILE), JSON.stringify(body), 'utf8')
const buildDist = () => writeFileSync(join(dir, 'index.html'), INDEX_HTML)

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
    expect(describeBundleDiagnostic(status)).toBeNull()
  })

  it('calls a mismatched pair stale and gives the operator a diagnostic', () => {
    buildDist()
    stamp({ wireSchemaDigest: 'deadbeefdeadbeef', builtAt: '2026-07-31T23:17:00Z' })
    const status = gradeWebBundle(dir)
    expect(status.grade).toBe('stale')
    expect(status.bundleDigest).toBe('deadbeefdeadbeef')
    expect(status.serverDigest).toBe(wireSchemaDigest())
    const diagnostic = describeBundleDiagnostic(status) ?? ''
    expect(diagnostic).toContain('wire-schema digest differs')
    expect(diagnostic).toContain('rebuild the web bundle or restart the server')
    expect(diagnostic).not.toContain('Repair and reload')
    expect(diagnostic).not.toContain('deadbeef')
  })

  it('refuses to certify a dist with NO stamp — the pre-fix artefact', () => {
    // The case the whole gate exists for: a dist built before any of this shipped
    // cannot be checked, and "cannot be checked" must not read as "fine".
    buildDist()
    expect(gradeWebBundle(dir).grade).toBe('unstamped')
    expect(describeBundleDiagnostic(gradeWebBundle(dir))).toContain('cannot be verified')
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
    expect(describeBundleDiagnostic(status)).toBeNull()
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
    // A rebuild while the server runs must clear the diagnostic without a restart.
    stamp({ wireSchemaDigest: wireSchemaDigest(), builtAt: '2026-08-03T12:00:00Z' })
    expect(gradeWebBundle(dir).grade).toBe('ok')
  })

  it('serves a stale bundle without injecting any bundle-warning markup', async () => {
    buildDist()
    stamp({ wireSchemaDigest: 'deadbeefdeadbeef' })
    expect(gradeWebBundle(dir).grade).toBe('stale')

    const app = new Hono()
    registerDesktopWebStatic(app, dir)
    const html = await (await app.request('/')).text()

    expect(html).toBe(INDEX_HTML)
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('Repair and reload')
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

/**
 * THE FACT A LOADED PAGE ACTUALLY DEPENDS ON (POD-2721).
 *
 * The checkout answers "is this dist on the commit we want". The BUNDLE answers
 * "are the URLs an open page is holding still the URLs on this disk", and the
 * incident that needed it had one checkout and two bundles.
 */
describe('what a served website says about its bundle', () => {
  it('reports the entry bundle beside the checkout', () => {
    buildDist()
    stamp({
      wireSchemaDigest: wireSchemaDigest(),
      sourceSha: 'a55ec3d',
      bundleVersion: 'bundle+Bw5YMffE',
    })
    expect(servedWebIdentity(dir).bundle).toBe('bundle+Bw5YMffE')
  })

  it('distinguishes two builds of ONE checkout, which the digest cannot', () => {
    buildDist()
    stamp({ wireSchemaDigest: wireSchemaDigest(), sourceSha: 'a55ec3d', bundleVersion: 'bundle+Bw5YMffE' })
    const packaged = servedWebIdentity(dir)
    stamp({ wireSchemaDigest: wireSchemaDigest(), sourceSha: 'a55ec3d', bundleVersion: 'bundle+CFyX4Q_p' })
    const devRelease = servedWebIdentity(dir)
    expect(devRelease.digest).toBe(packaged.digest)
    expect(devRelease.bundle).not.toBe(packaged.bundle)
  })

  it('names no bundle when the stamp does not, rather than inventing one', () => {
    buildDist()
    stamp({ wireSchemaDigest: wireSchemaDigest(), sourceSha: '47a01e3' })
    expect(servedWebIdentity(dir).bundle).toBeUndefined()
  })
})
