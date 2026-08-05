import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPortableCredential, readPortableCredential } from './credentials'

let source: string
let target: string

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), 'podium-credential-source-'))
  target = mkdtempSync(join(tmpdir(), 'podium-credential-target-'))
})

afterEach(() => {
  rmSync(source, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

describe('portable native credentials', () => {
  it('copies only the known Codex auth file and installs it owner-only', () => {
    mkdirSync(join(source, '.codex'), { recursive: true })
    const secret = JSON.stringify({ tokens: { access_token: 'do-not-log' } })
    writeFileSync(join(source, '.codex', 'auth.json'), secret)

    const bundle = readPortableCredential('codex', source)
    expect(bundle?.kind).toBe('codex')
    if (!bundle) throw new Error('bundle missing')
    installPortableCredential(bundle, target)

    const path = join(target, '.codex', 'auth.json')
    expect(readFileSync(path, 'utf8')).toBe(secret)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(target, '.codex')).mode & 0o777).toBe(0o700)
  })

  it('refuses malformed or missing auth files', () => {
    expect(readPortableCredential('grok', source)).toBeNull()
    mkdirSync(join(source, '.grok'), { recursive: true })
    writeFileSync(join(source, '.grok', 'auth.json'), 'not-json')
    expect(() => readPortableCredential('grok', source)).toThrow()
    expect(() =>
      installPortableCredential(
        { kind: 'grok', contentBase64: Buffer.from('bad').toString('base64') },
        target,
      ),
    ).toThrow()
  })

  it('copies only Claude onboarding markers and merges them into target-local state', () => {
    writeFileSync(
      join(source, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.92',
        installMethod: 'native',
        machineID: 'must-not-cross-machines',
        projects: { '/secret/source/path': {} },
        oauthAccount: { emailAddress: 'must-not-cross' },
      }),
    )
    writeFileSync(
      join(target, '.claude.json'),
      JSON.stringify({ machineID: 'target-machine', projects: { '/target/path': {} } }),
    )

    const bundle = readPortableCredential('claude-code-state', source)
    expect(bundle).not.toBeNull()
    if (!bundle) throw new Error('bundle missing')
    expect(JSON.parse(Buffer.from(bundle.contentBase64, 'base64').toString('utf8'))).toEqual({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.92',
      installMethod: 'native',
    })
    installPortableCredential(bundle, target)

    const path = join(target, '.claude.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      machineID: 'target-machine',
      projects: { '/target/path': {} },
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.92',
      installMethod: 'native',
    })
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  })
})

function codexAuth(freshness: number, access = 'access', refresh = 'refresh'): string {
  return JSON.stringify({
    tokens: {
      access_token: access,
      refresh_token: refresh,
      expires_at: freshness,
    },
  })
}

describe('guarded native propagation', () => {
  const previousCodexHome = process.env.CODEX_HOME

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  })

  it('writes the real Codex home and never replaces a valid local login', () => {
    process.env.CODEX_HOME = join(target, 'managed-home')
    const candidate = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(200, 'donor', 'donor-refresh')).toString('base64'),
    }

    expect(installPortableCredential(candidate, target, { realHome: true, guarded: true })).toBe(true)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toContain('donor')
    expect(() => readFileSync(join(target, 'managed-home', 'auth.json'))).toThrow()

    const local = codexAuth(300, 'local', 'local-refresh')
    writeFileSync(join(target, '.codex', 'auth.json'), local)
    expect(installPortableCredential(candidate, target, { realHome: true, guarded: true })).toBe(false)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toBe(local)
  })

  it('only replaces an invalid target with strictly fresher comparable bytes', () => {
    mkdirSync(join(target, '.codex'), { recursive: true })
    const current = codexAuth(100, 'stale-target', '')
    writeFileSync(join(target, '.codex', 'auth.json'), current)

    const fresher = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(200, 'donor', 'donor-refresh')).toString('base64'),
    }
    expect(installPortableCredential(fresher, target, { realHome: true, guarded: true })).toBe(true)

    writeFileSync(join(target, '.codex', 'auth.json'), codexAuth(200, 'stale-target', ''))
    const older = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(150, 'older', 'older-refresh')).toString('base64'),
    }
    expect(installPortableCredential(older, target, { realHome: true, guarded: true })).toBe(false)

    writeFileSync(join(target, '.codex', 'auth.json'), codexAuth(200, 'stale-target', ''))
    const unknown = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(Number.NaN, 'unknown', 'unknown-refresh')).toString('base64'),
    }
    const beforeUnknown = readFileSync(join(target, '.codex', 'auth.json'), 'utf8')
    expect(installPortableCredential(unknown, target, { realHome: true, guarded: true })).toBe(false)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toBe(beforeUnknown)
  })
  it('writes the real Claude credential path and protects a valid local login', () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(target, 'managed-claude')
    const candidate = {
      kind: 'claude-code' as const,
      contentBase64: Buffer.from(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'donor-access',
            refreshToken: 'donor-refresh',
            expiresAt: 200,
          },
        }),
      ).toString('base64'),
    }

    try {
      expect(installPortableCredential(candidate, target, { realHome: true, guarded: true })).toBe(
        true,
      )
      expect(readFileSync(join(target, '.claude', '.credentials.json'), 'utf8')).toContain(
        'donor-access',
      )
      expect(() => readFileSync(join(target, 'managed-claude', '.credentials.json'))).toThrow()

      const local = JSON.stringify({
        claudeAiOauth: {
          accessToken: 'local-access',
          refreshToken: 'local-refresh',
          expiresAt: 300,
        },
      })
      writeFileSync(join(target, '.claude', '.credentials.json'), local)
      expect(
        installPortableCredential(candidate, target, { realHome: true, guarded: true }),
      ).toBe(false)
      expect(readFileSync(join(target, '.claude', '.credentials.json'), 'utf8')).toBe(local)
    } finally {
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
  })

})
