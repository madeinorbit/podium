/**
 * The Install steps come from the adapters, never from the mechanism: these
 * tests pin the per-harness facts (installer URL, shell, required env, binary)
 * through the mechanism's narrow reader, with injected host operations.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installableTargets, installTargetFor, runInstallTarget } from './install'
import { quotaAgentLabel } from './usage'

describe('installTargetFor', () => {
  it('resolves the installable harnesses with the binary each install produces', () => {
    expect(installableTargets()).toEqual([
      { kind: 'claude-code', displayName: 'Claude', binary: 'claude' },
      { kind: 'codex', displayName: 'Codex', binary: 'codex' },
      { kind: 'grok', displayName: 'Grok', binary: 'grok' },
    ])
  })

  it('refuses an unknown harness id rather than substituting another CLI', () => {
    expect(() => installTargetFor('emacs')).toThrow("unsupported agent 'emacs'")
  })

  it.each([
    ['opencode', 'no single vendor install script'],
    ['cursor', "Cursor's own installer"],
    ['pi', 'no single vendor install script'],
  ])('refuses %s with the section reason — no guessed vendor URL', (kind, reason) => {
    expect(() => installTargetFor(kind)).toThrow(reason)
  })
})

describe('runInstallTarget — steps come from the adapter', () => {
  let bin: string
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'podium-install-'))
  })
  afterEach(() => {
    rmSync(bin, { recursive: true, force: true })
  })

  const ports = (over: Record<string, unknown> = {}) => ({
    fetch: vi.fn((_url: string, out: string) => writeFileSync(out, '#!/bin/sh\n')),
    run: vi.fn(() => ''),
    env: {} as NodeJS.ProcessEnv,
    ...over,
  })

  it('runs the Codex installer with the env its script requires', () => {
    const p = ports()
    runInstallTarget(installTargetFor('codex'), bin, p)
    expect(p.fetch).toHaveBeenCalledTimes(1)
    expect(p.fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/codex/install.sh')
    const calls = p.run.mock.calls as unknown as [string, string[], NodeJS.ProcessEnv][]
    const installer = calls.find((c) => c[0] === 'sh')
    expect(installer?.[2]).toMatchObject({ CODEX_NON_INTERACTIVE: '1', CODEX_INSTALL_DIR: bin })
  })

  it('honours the installer URL override from the environment', () => {
    const p = ports({ env: { PODIUM_CODEX_INSTALL_URL: 'https://example.invalid/x.sh' } })
    runInstallTarget(installTargetFor('codex'), bin, p)
    expect(p.fetch.mock.calls[0]?.[0]).toBe('https://example.invalid/x.sh')
  })

  it('runs the Grok installer with its bin-dir variable', () => {
    const p = ports()
    runInstallTarget(installTargetFor('grok'), bin, p)
    expect(p.fetch.mock.calls[0]?.[0]).toBe('https://x.ai/cli/install.sh')
    const calls = p.run.mock.calls as unknown as [string, string[], NodeJS.ProcessEnv][]
    const installer = calls.find((c) => c[2].GROK_BIN_DIR !== undefined)
    expect(installer?.[0]).toBe('bash')
    expect(installer?.[2].GROK_BIN_DIR).toBe(bin)
  })

  it('verifies each agent actually runs before counting it installed', () => {
    const p = ports()
    runInstallTarget(installTargetFor('codex'), bin, p)
    const calls = p.run.mock.calls as unknown as [string, string[]][]
    expect(calls.some((c) => c[0] === join(bin, 'codex') && c[1][0] === '--version')).toBe(true)
  })

  it('a failing verify fails the install', () => {
    const p = ports({
      run: vi.fn((cmd: string) => {
        if (cmd.endsWith('codex')) throw new Error('vendor exploded')
        return ''
      }),
    })
    expect(() => runInstallTarget(installTargetFor('codex'), bin, p)).toThrow('vendor exploded')
  })

  it('falls back to the checksum-verified standalone when the Claude self-installer fails', () => {
    const version = '1.2.3'
    const body = '#!/bin/sh\necho claude-standalone-fixture\n'
    const sha = createHash('sha256').update(body).digest('hex')
    const rel = mkdtempSync(join(tmpdir(), 'podium-claude-rel-'))
    try {
      mkdirSync(join(rel, version, 'linux-x64'), { recursive: true })
      writeFileSync(join(rel, 'latest'), `${version}\n`)
      writeFileSync(join(rel, version, 'linux-x64', 'claude'), body)
      const noted: string[] = []
      const p = ports({
        env: { PODIUM_CLAUDE_RELEASE_BASE_URL: rel } as NodeJS.ProcessEnv,
        arch: 'x64',
        isMusl: () => false,
        fetch: (url: string, out: string) => {
          if (url.endsWith('install.sh')) {
            writeFileSync(out, '#!/bin/sh\n')
            return
          }
          if (url.endsWith('manifest.json')) {
            writeFileSync(
              out,
              JSON.stringify({ platforms: { 'linux-x64': { checksum: sha } } }),
            )
            return
          }
          writeFileSync(out, readFileSync(url))
        },
        run: vi.fn((cmd: string) => {
          if (cmd === 'bash') throw new Error('self-stage failed')
          return ''
        }),
        note: (message: string) => void noted.push(message),
      })
      runInstallTarget(installTargetFor('claude-code'), bin, p)
      expect(noted.join('\n')).toContain('standalone fallback')
      expect(readFileSync(join(bin, 'claude'), 'utf8')).toBe(body)
    } finally {
      rmSync(rel, { recursive: true, force: true })
    }
  })
})

describe('quotaAgentLabel', () => {
  it('reads the label off the manifest — no second table', () => {
    expect(quotaAgentLabel('codex')).toBe('Codex')
    expect(quotaAgentLabel('claude-code')).toBe('Claude')
    expect(quotaAgentLabel('grok')).toBe('Grok')
  })

  it('degrades unknown ids to a capitalized id, never another CLI', () => {
    expect(quotaAgentLabel('shell')).toBe('Shell')
    expect(quotaAgentLabel('future-harness')).toBe('Future-harness')
  })
})
