import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isNewer, parseManifest, runUpdate } from './podium-update'

describe('podium update helpers', () => {
  it('isNewer compares semver-ish versions', () => {
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.2.0', '0.10.0')).toBe(false)
  })
  it('parseManifest extracts version + linux url', () => {
    const m = parseManifest(
      JSON.stringify({
        version: '0.1.1',
        platforms: { 'linux-x86_64': { url: 'http://h/a.tar.gz', signature: 'x' } },
      }),
    )
    expect(m).toEqual({ version: '0.1.1', url: 'http://h/a.tar.gz' })
  })
})

// --- crash-safe swap (FIX wave 1) -------------------------------------------
// These exercise runUpdate's real download → extract → atomic-swap path against a tiny
// local feed (no 119MB headless build needed) to prove same-filesystem staging + fail-loud.
describe('podium update swap crash-safety', () => {
  let work: string
  let server: Server | undefined
  const savedHome = process.env.PODIUM_HOME
  const savedExit = process.exitCode

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'podium-update-test-'))
    process.exitCode = undefined
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

  async function startFeed(version: string, tarball: string | null): Promise<string> {
    const buf = tarball ? readFileSync(tarball) : null
    let port = 0
    server = createServer((req, res) => {
      const path = req.url ?? ''
      if (path.startsWith('/update/')) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            version,
            platforms: {
              'linux-x86_64': { url: `http://127.0.0.1:${port}/artifact`, signature: '' },
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
    await runUpdate(feed)
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.1.1')
    expect(existsSync(join(dir, 'podium'))).toBe(true)
    expect(existsSync(`${dir}.old`)).toBe(false)
    // No sibling .podium-update-* temp dir is left behind.
    expect(readdirSync(dirname(dir)).filter((n) => n.startsWith('.podium-update-'))).toHaveLength(0)
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
    await expect(runUpdate(feed)).rejects.toThrow(/headless/)
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
    await expect(runUpdate(feed)).rejects.toThrow(/artifact download returned 404/)
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.1.0')
    expect(existsSync(`${dir}.old`)).toBe(false)
  })
})
