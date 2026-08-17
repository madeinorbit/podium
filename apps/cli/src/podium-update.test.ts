import { execFileSync } from 'node:child_process'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNewer,
  manifestUrlFor,
  parseManifest,
  platformTarget,
  runUpdate,
} from './podium-update'

/**
 * PRERELEASE-SAFE SELF-UPDATE (POD-2099). Podium's own releases ARE
 * prereleases, so the edge channel is the ordinary case here, not the exotic
 * one: `Number('4-edge')` is NaN and the old comparison degraded to "not
 * newer" for every edge-to-edge pair.
 *
 * Table-driven because the interesting content is the pairs, and one case per
 * `it` would hide which rule each pair is really about.
 */
describe('isNewer', () => {
  const cases: [candidate: string, current: string, newer: boolean, why: string][] = [
    ['0.1.1', '0.1.0', true, 'a later patch'],
    ['0.1.0', '0.1.0', false, 'the same version'],
    ['0.2.0', '0.10.0', false, 'numeric core components, not text'],
    ['0.1.4-edge.10', '0.1.4-edge.4', true, 'numeric prerelease identifiers count, not sort'],
    ['0.1.4-edge.4', '0.1.4-edge.10', false, 'and the other way round'],
    ['0.1.4-edge.4', '0.1.4-edge.4', false, 'the same prerelease'],
    ['0.1.4', '0.1.4-edge.4', true, 'the release outranks its own prereleases'],
    ['0.1.4-edge.4', '0.1.4', false, 'and a prerelease never overwrites the release'],
    ['0.1.5-edge.1', '0.1.4', true, 'a prerelease of a LATER version still wins'],
    ['0.1.4-edge.4', '0.1.3', true, 'edge moving forward across a patch'],
    ['0.1.4-edge', '0.1.4-edge.1', false, 'fewer identifiers rank lower'],
    ['0.1.4-edge.1', '0.1.4-edge', true, 'and more identifiers rank higher'],
    ['0.1.4-beta', '0.1.4-alpha', true, 'alphanumeric identifiers compare as text'],
    ['0.1.4-alpha.1', '0.1.4-alpha.beta', false, 'numeric ranks below alphanumeric'],
    ['0.1.4+abc1234', '0.1.4', false, 'build metadata takes no part in precedence'],
    ['0.1.5+abc1234', '0.1.4', true, 'and does not prevent a real comparison either'],
    // FAIL CLOSED. A false negative leaves an install where it is; a false
    // positive swaps an install directory on a label nobody could read.
    ['0.1.4', 'dev', false, 'a source checkout has no place on this ordering'],
    ['dev+abc1234', '0.1.4', false, 'nor does the label it reports'],
    ['0.1.4', 'dev+abc1234', false, 'in either position'],
    ['', '0.1.4', false, 'an empty version'],
    ['0.1', '0.1.4', false, 'a two-component version is not a semver'],
    ['0.1.4.5', '0.1.4', false, 'nor is a four-component one'],
    ['latest', '0.1.4', false, 'nor a channel name'],
    ['0.1.4-', '0.1.4-edge', false, 'nor an empty prerelease'],
    ['0.1.4-edge..1', '0.1.4-edge.1', false, 'nor an empty identifier inside one'],
  ]

  for (const [candidate, current, newer, why] of cases) {
    it(`${newer ? 'updates' : 'stays put'}: ${candidate || '<empty>'} vs ${current} — ${why}`, () => {
      expect(isNewer(candidate, current)).toBe(newer)
    })
  }
})

describe('compareVersions numeric prerelease syntax', () => {
  const cases: [left: string, right: string, order: number | null, why: string][] = [
    ['0.1.4-edge.0', '0.1.4-edge.1', -1, 'zero itself is a valid numeric identifier'],
    ['0.1.4-edge.10', '0.1.4-edge.2', 1, 'multi-digit identifiers may start nonzero'],
    ['00.1.5', '0.1.4', null, 'a major component cannot have a leading zero'],
    ['0.01.5', '0.1.4', null, 'a minor component cannot have a leading zero'],
    ['0.1.05', '0.1.4', null, 'a patch component cannot have a leading zero'],
    ['0.1.4-edge.00', '0.1.4-edge.0', null, 'multiple zeroes are malformed'],
    ['0.1.4-edge.01', '0.1.4-edge.1', null, 'a leading zero is malformed on the left'],
    ['0.1.5', '0.1.4-edge.01', null, 'a leading zero is malformed on the right'],
  ]

  for (const [left, right, order, why] of cases) {
    it(`${left} vs ${right} — ${why}`, () => {
      expect(compareVersions(left, right)).toBe(order)
    })
  }
})

describe('podium update helpers', () => {
  it('parseManifest extracts version + linux url + signature', () => {
    const m = parseManifest(
      JSON.stringify({
        version: '0.1.1',
        platforms: { 'linux-x86_64': { url: 'http://h/a.tar.gz', signature: 'sig123' } },
      }),
    )
    expect(m).toEqual({ version: '0.1.1', url: 'http://h/a.tar.gz', signature: 'sig123' })
  })
  it('parseManifest defaults a missing signature to empty string', () => {
    const m = parseManifest(
      JSON.stringify({
        version: '0.1.1',
        platforms: { 'linux-x86_64': { url: 'http://h/a.tar.gz' } },
      }),
    )
    expect(m.signature).toBe('')
  })
  it('parseManifest resolves the requested platform from a multi-platform manifest', () => {
    const json = JSON.stringify({
      version: '0.1.1',
      platforms: {
        'linux-x86_64': { url: 'http://h/linux.tar.gz', signature: 'sigL' },
        'darwin-aarch64': { url: 'http://h/mac.tar.gz', signature: 'sigM' },
      },
    })
    expect(parseManifest(json, 'darwin-aarch64')).toEqual({
      version: '0.1.1',
      url: 'http://h/mac.tar.gz',
      signature: 'sigM',
    })
    // Default target keeps the historical linux-x64 behavior.
    expect(parseManifest(json).url).toBe('http://h/linux.tar.gz')
  })
  it('parseManifest throws naming the missing target', () => {
    const json = JSON.stringify({
      version: '0.1.1',
      platforms: { 'linux-x86_64': { url: 'http://h/a.tar.gz' } },
    })
    expect(() => parseManifest(json, 'windows-x86_64')).toThrow(/windows-x86_64/)
  })
  it('platformTarget maps node (platform, arch) pairs to manifest asset keys', () => {
    expect(platformTarget('linux', 'x64')).toBe('linux-x86_64')
    expect(platformTarget('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(platformTarget('darwin', 'x64')).toBe('darwin-x86_64')
    expect(platformTarget('win32', 'x64')).toBe('windows-x86_64')
    expect(platformTarget('linux', 'arm64')).toBe('linux-aarch64')
  })
})

// The `verifyTarball` arms that stood here moved to
// `packages/runtime/src/update-delivery.test.ts` with the function itself
// (POD-2106) — the CLI had a byte-identical copy, and one security primitive
// gets one home. `runUpdate`'s signature GATE is still tested below, where it
// belongs: that is the CLI's own behaviour, not the primitive's.

// --- crash-safe swap (FIX wave 1) -------------------------------------------
// These exercise runUpdate's real download → extract → atomic-swap path against a tiny
// local feed (no 119MB headless build needed) to prove same-filesystem staging + fail-loud.
// They sign the served tarball with the PRIVATE half of PODIUM_UPDATE_PUBKEY when the
// gitignored dev key is available. On clean checkouts they generate an ephemeral Ed25519 keypair
// and pass its public half through runUpdate's explicit pubkeyB64 test seam instead.
describe('podium update swap crash-safety', () => {
  let work: string
  let server: Server | undefined
  const savedHome = process.env.PODIUM_HOME
  const savedExit = process.exitCode

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'podium-update-test-'))
    process.exitCode = 0
  })
  afterEach(() => {
    server?.close()
    server = undefined
    if (savedHome === undefined) delete process.env.PODIUM_HOME
    else process.env.PODIUM_HOME = savedHome
    process.exitCode = savedExit
    rmSync(work, { recursive: true, force: true })
  })

  function listen(s: Server): Promise<number> {
    return new Promise((resolve) => {
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port))
    })
  }

  // The dev signing key (private half) — gitignored, matches PODIUM_UPDATE_PUBKEY. Used to
  // sign served tarballs so runUpdate's real verify gate passes against the committed pubkey.
  // Clean checkouts (CI, fresh clones) don't have the key file, so fall back to an ephemeral
  // Ed25519 keypair and hand runUpdate the matching pubkey via its test seam — the
  // download→verify→swap path under test is identical either way.
  const devKeyPath = join(__dirname, '.podium-update-dev.key')
  const ephemeral = existsSync(devKeyPath) ? undefined : generateKeyPairSync('ed25519')
  // undefined ⇒ runUpdate verifies against the committed PODIUM_UPDATE_PUBKEY default.
  const testPubkeyB64 = ephemeral
    ? ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    : undefined
  function devSign(bytes: Buffer): string {
    if (ephemeral) return cryptoSign(null, bytes, ephemeral.privateKey).toString('base64')
    const der = Buffer.from(readFileSync(devKeyPath, 'utf8').trim(), 'base64')
    const key = { key: der, format: 'der' as const, type: 'pkcs8' as const }
    return cryptoSign(null, bytes, key).toString('base64')
  }

  // Build a v0.1.1 tarball whose root is `headless/`, mirroring the real artifact layout.
  function makeTarball(version: string): string {
    const stage = join(work, 'stage')
    const root = join(stage, 'headless')
    execFileSync('mkdir', ['-p', root])
    writeFileSync(join(root, 'VERSION'), `${version}\n`)
    writeFileSync(join(root, 'podium'), '#!/bin/sh\n')
    const tarball = join(work, 'bundle.tar.gz')
    execFileSync('tar', ['-czf', tarball, '-C', stage, 'headless'])
    return tarball
  }

  // signature: 'sign' => valid dev signature of the served bytes; 'bad' => a wrong signature.
  async function startFeed(
    version: string,
    tarball: string | null,
    signature: 'sign' | 'bad' = 'sign',
  ): Promise<string> {
    const buf = tarball ? readFileSync(tarball) : null
    const sig = buf ? (signature === 'sign' ? devSign(buf) : 'AAAA') : ''
    let port = 0
    server = createServer((req, res) => {
      const path = req.url ?? ''
      if (path.startsWith('/update/')) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            version,
            platforms: {
              'linux-x86_64': { url: `http://127.0.0.1:${port}/artifact`, signature: sig },
            },
          }),
        )
        return
      }
      if (path === '/artifact') {
        if (buf) res.end(buf)
        else {
          res.statusCode = 404
          res.end('gone')
        }
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    port = await listen(server)
    return `http://127.0.0.1:${port}`
  }

  function stageInstall(version: string): string {
    const dir = join(work, 'install')
    execFileSync('mkdir', ['-p', dir])
    writeFileSync(join(dir, 'VERSION'), `${version}\n`)
    writeFileSync(join(dir, 'podium'), '#!/bin/sh\n')
    process.env.PODIUM_HOME = dir
    return dir
  }

  it('swaps the install dir to the new version (same-filesystem staging)', async () => {
    const dir = stageInstall('0.1.0')
    const feed = await startFeed('0.1.1', makeTarball('0.1.1'))
    await runUpdate(feed, testPubkeyB64, () => false)
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.1.1')
    expect(existsSync(join(dir, 'podium'))).toBe(true)
    expect(existsSync(`${dir}.old`)).toBe(false)
    // No sibling .podium-update-* temp dir is left behind.
    expect(readdirSync(dirname(dir)).filter((n) => n.startsWith('.podium-update-'))).toHaveLength(0)
    // Signal "actually updated" via exit code 10 so the systemd timer only restarts the
    // daemon when a real swap happened (0 = already current, 1 = failure).
    expect(process.exitCode).toBe(10)
  })

  it('exits 0 (no restart signal) when already up to date', async () => {
    stageInstall('0.1.1')
    // Feed advertises the SAME version → not newer → early return before any download/verify,
    // so this needs no signing key and never swaps. Exit code stays 0 (unset).
    const feed = await startFeed('0.1.1', null)
    await runUpdate(feed, testPubkeyB64)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('REFUSES to swap when signature verification fails (tampered tarball)', async () => {
    const dir = stageInstall('0.1.0')
    const parent = dirname(dir)
    // Feed advertises a newer version + a real tarball, but with a WRONG signature.
    const feed = await startFeed('0.1.1', makeTarball('0.1.1'), 'bad')
    await runUpdate(feed, testPubkeyB64)
    // Fail closed: exitCode set, install untouched, no backup, no leftover staging dir.
    expect(process.exitCode).toBe(1)
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.1.0')
    expect(existsSync(`${dir}.old`)).toBe(false)
    expect(readdirSync(parent).filter((n) => n.startsWith('.podium-update-'))).toHaveLength(0)
  })

  it('stages on the install dir filesystem, not tmpdir (sibling temp dir)', async () => {
    const dir = stageInstall('0.1.0')
    const parent = dirname(dir)
    // Trip a swap failure AFTER staging by leaving a sentinel we can scan for: we assert the
    // temp dir is created as a sibling. Use a feed whose tarball lacks headless/ so the swap
    // is skipped but extraction already happened in the sibling dir during this call.
    const badTar = join(work, 'bad.tar.gz')
    const wrong = join(work, 'wrong')
    execFileSync('mkdir', ['-p', join(wrong, 'notheadless')])
    execFileSync('tar', ['-czf', badTar, '-C', wrong, 'notheadless'])
    const feed = await startFeed('0.1.1', badTar)
    await expect(runUpdate(feed, testPubkeyB64)).rejects.toThrow(/headless/)
    // Install dir survives untouched; no leftover sibling temp dir; backup never created.
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.1.0')
    expect(existsSync(`${dir}.old`)).toBe(false)
    expect(readdirSync(parent).filter((n) => n.startsWith('.podium-update-'))).toHaveLength(0)
  })

  it('fails loud (exitCode=1) on a non-OK manifest response', async () => {
    stageInstall('0.1.0')
    server = createServer((_req, res) => {
      res.statusCode = 503
      res.end('nope')
    })
    const port = await listen(server)
    await runUpdate(`http://127.0.0.1:${port}`)
    expect(process.exitCode).toBe(1)
  })

  it('throws on a non-OK artifact download (install dir untouched)', async () => {
    const dir = stageInstall('0.1.0')
    const feed = await startFeed('0.1.1', null) // manifest OK, /artifact 404s
    await expect(runUpdate(feed, testPubkeyB64)).rejects.toThrow(/artifact download returned 404/)
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.1.0')
    expect(existsSync(`${dir}.old`)).toBe(false)
  })
})

describe('manifestUrlFor', () => {
  it('stable → latest/download static manifest on GitHub', () => {
    expect(manifestUrlFor('stable', { target: 'linux-x86_64', cur: '0.1.0' })).toBe(
      'https://github.com/madeinorbit/podium/releases/latest/download/podium-update.json',
    )
  })
  it('edge → the rolling edge prerelease manifest', () => {
    expect(manifestUrlFor('edge', { target: 'linux-x86_64', cur: '0.1.0' })).toBe(
      'https://github.com/madeinorbit/podium/releases/download/edge/podium-update.json',
    )
  })
  it('a feedOverride preserves the legacy templated path (for the fixture feed)', () => {
    expect(
      manifestUrlFor('stable', {
        target: 'linux-x86_64',
        cur: '0.1.0',
        feedOverride: 'http://127.0.0.1:8789',
      }),
    ).toBe('http://127.0.0.1:8789/update/linux-x86_64/x86_64/0.1.0')
  })
})
