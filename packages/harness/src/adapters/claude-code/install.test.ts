import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installClaudeStandalone } from './install'

describe('installClaudeStandalone — the fallback when self-staging fails', () => {
  let bin: string
  let rel: string
  const VERSION = '1.2.3'
  const BODY = '#!/bin/sh\necho claude-standalone-fixture\n'
  const sha = createHash('sha256').update(BODY).digest('hex')

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'podium-claude-bin-'))
    rel = mkdtempSync(join(tmpdir(), 'podium-claude-rel-'))
    mkdirSync(join(rel, VERSION, 'linux-x64'), { recursive: true })
    writeFileSync(join(rel, 'latest'), `${VERSION}\n`)
    writeFileSync(join(rel, VERSION, 'linux-x64', 'claude'), BODY)
  })
  afterEach(() => {
    rmSync(bin, { recursive: true, force: true })
    rmSync(rel, { recursive: true, force: true })
  })

  const manifest = (checksum: string) =>
    JSON.stringify({ platforms: { 'linux-x64': { checksum } } })

  // The vendor's release layout, served from a temp dir: `latest`, a manifest, and the binary.
  const fetchFrom = (checksum: string) => ({
    env: { PODIUM_CLAUDE_RELEASE_BASE_URL: rel } as NodeJS.ProcessEnv,
    arch: 'x64',
    isMusl: () => false,
    fetch: (url: string, out: string) => {
      if (url.endsWith('manifest.json')) {
        writeFileSync(out, manifest(checksum))
        return
      }
      writeFileSync(out, readFileSync(url))
    },
  })

  it('installs the binary when the manifest checksum matches', () => {
    installClaudeStandalone(bin, fetchFrom(sha))
    expect(readFileSync(join(bin, 'claude'), 'utf8')).toBe(BODY)
  })

  it('refuses a checksum that does not match, and installs nothing', () => {
    expect(() => installClaudeStandalone(bin, fetchFrom('0'.repeat(64)))).toThrow(
      'checksum verification FAILED',
    )
    expect(existsSync(join(bin, 'claude'))).toBe(false)
  })

  it('refuses a manifest whose checksum is not 64 hex characters', () => {
    expect(() => installClaudeStandalone(bin, fetchFrom('abc'))).toThrow('no valid checksum')
    expect(existsSync(join(bin, 'claude'))).toBe(false)
  })

  it('refuses a version string that could be smuggled into a URL path', () => {
    const d = fetchFrom(sha)
    const bad = {
      ...d,
      fetch: (url: string, out: string) => {
        if (url.endsWith('/latest')) {
          writeFileSync(out, '1.2.3/../../etc\n')
          return
        }
        d.fetch(url, out)
      },
    }
    expect(() => installClaudeStandalone(bin, bad)).toThrow(/unsafe version/)
  })

  it('leaves no partially written binary reachable under the real name', () => {
    const d = fetchFrom(sha)
    const bad = {
      ...d,
      fetch: (url: string, out: string) => {
        if (url.endsWith('/claude')) throw new Error('network died mid-download')
        d.fetch(url, out)
      },
    }
    expect(() => installClaudeStandalone(bin, bad)).toThrow()
    expect(existsSync(join(bin, 'claude'))).toBe(false)
  })
})
