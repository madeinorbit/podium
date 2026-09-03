import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAgents, installClaudeStandalone } from './install-agents'
import { scriptedIO } from './setup-ui'

describe('installAgents', () => {
  let bin: string
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'podium-agents-'))
  })
  afterEach(() => {
    rmSync(bin, { recursive: true, force: true })
  })

  const deps = (over: Record<string, unknown> = {}) => ({
    fetch: vi.fn((_url: string, out: string) => writeFileSync(out, '#!/bin/sh\n')),
    run: vi.fn(() => ''),
    env: {} as NodeJS.ProcessEnv,
    ...over,
  })

  it('runs each requested vendor installer once, in the order asked', async () => {
    const d = deps()
    const { io } = scriptedIO([])
    const res = await installAgents(io, ['codex', 'grok'], bin, d)
    expect(res.map((r) => r.id)).toEqual(['codex', 'grok'])
    expect(res.every((r) => r.ok)).toBe(true)
    expect(d.fetch).toHaveBeenCalledTimes(2)
  })

  it('passes each vendor the environment its installer requires', async () => {
    // Getting these wrong is silent: codex exits non-zero without CODEX_NON_INTERACTIVE, and
    // both vendors install to the wrong directory without their BIN_DIR variable.
    const d = deps()
    const { io } = scriptedIO([])
    await installAgents(io, ['codex', 'grok'], bin, d)
    const calls = d.run.mock.calls as unknown as [string, string[], NodeJS.ProcessEnv][]
    const codex = calls.find((c) => c[2].CODEX_INSTALL_DIR !== undefined)
    expect(codex?.[2]).toMatchObject({ CODEX_NON_INTERACTIVE: '1', CODEX_INSTALL_DIR: bin })
    expect(calls.find((c) => c[2].GROK_BIN_DIR !== undefined)?.[2].GROK_BIN_DIR).toBe(bin)
  })

  it('verifies each agent actually runs before calling it installed', async () => {
    const d = deps()
    const { io } = scriptedIO([])
    await installAgents(io, ['codex'], bin, d)
    const calls = d.run.mock.calls as unknown as [string, string[]][]
    expect(calls.some((c) => c[0] === join(bin, 'codex') && c[1][0] === '--version')).toBe(true)
  })

  it('keeps vendor output hidden on success and shows it on failure', async () => {
    const quiet = scriptedIO([])
    await installAgents(quiet.io, ['codex'], bin, deps())
    expect(quiet.output.join('\n')).not.toContain('npm WARN')

    const loud = scriptedIO([])
    const res = await installAgents(loud.io, ['codex'], bin, {
      ...deps(),
      run: vi.fn(() => {
        throw new Error('npm WARN deprecated\nvendor exploded')
      }),
    })
    expect(res[0]?.ok).toBe(false)
    expect(loud.output.join('\n')).toContain('vendor exploded')
  })

  it('does not abort the remaining agents when one fails', async () => {
    let n = 0
    const { io } = scriptedIO([])
    const res = await installAgents(io, ['codex', 'grok'], bin, {
      ...deps(),
      run: vi.fn(() => {
        n++
        if (n === 1) throw new Error('codex exploded')
        return ''
      }),
    })
    expect(res.map((r) => r.ok)).toEqual([false, true])
  })

  it('rejects an unsupported agent id rather than silently skipping it', async () => {
    const { io } = scriptedIO([])
    await expect(installAgents(io, ['emacs'], bin, deps())).rejects.toThrow('emacs')
  })
})

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
