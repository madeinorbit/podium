import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecurityResult, SecurityRunner } from './claude-keychain-security'
import type { DaemonContext } from './context'
import {
  handleCredentialExport,
  installPortableCredential,
  readPortableCredential,
} from './credentials'

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
  it('copies only the known Codex auth file and installs it owner-only', async () => {
    mkdirSync(join(source, '.codex'), { recursive: true })
    const secret = JSON.stringify({ tokens: { access_token: 'do-not-log' } })
    writeFileSync(join(source, '.codex', 'auth.json'), secret)

    const bundle = await readPortableCredential('codex', source)
    expect(bundle?.kind).toBe('codex')
    if (!bundle) throw new Error('bundle missing')
    await installPortableCredential(bundle, target)

    const path = join(target, '.codex', 'auth.json')
    expect(readFileSync(path, 'utf8')).toBe(secret)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(target, '.codex')).mode & 0o777).toBe(0o700)
  })

  it('refuses malformed or missing auth files', async () => {
    expect(await readPortableCredential('grok', source)).toBeNull()
    mkdirSync(join(source, '.grok'), { recursive: true })
    writeFileSync(join(source, '.grok', 'auth.json'), 'not-json')
    await expect(readPortableCredential('grok', source)).rejects.toThrow()
    await expect(
      installPortableCredential(
        { kind: 'grok', contentBase64: Buffer.from('bad').toString('base64') },
        target,
      ),
    ).rejects.toThrow()
  })

  it('copies only Claude onboarding markers and merges them into target-local state', async () => {
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

    const bundle = await readPortableCredential('claude-code-state', source)
    expect(bundle).not.toBeNull()
    if (!bundle) throw new Error('bundle missing')
    expect(JSON.parse(Buffer.from(bundle.contentBase64, 'base64').toString('utf8'))).toEqual({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.92',
      installMethod: 'native',
    })
    await installPortableCredential(bundle, target)

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

function claudeAuth(freshness: number, access = 'access', refresh = 'refresh'): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: freshness,
    },
  })
}

describe('guarded native propagation', () => {
  const previousCodexHome = process.env.CODEX_HOME

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  })

  it('writes the real Codex home and never replaces a valid local login', async () => {
    process.env.CODEX_HOME = join(target, 'managed-home')
    const candidate = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(200, 'donor', 'donor-refresh')).toString('base64'),
    }

    expect(
      await installPortableCredential(candidate, target, { realHome: true, guarded: true }),
    ).toBe(true)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toContain('donor')
    expect(() => readFileSync(join(target, 'managed-home', 'auth.json'))).toThrow()

    const local = codexAuth(300, 'local', 'local-refresh')
    writeFileSync(join(target, '.codex', 'auth.json'), local)
    expect(
      await installPortableCredential(candidate, target, { realHome: true, guarded: true }),
    ).toBe(false)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toBe(local)
  })

  it('only replaces an invalid target with strictly fresher comparable bytes', async () => {
    mkdirSync(join(target, '.codex'), { recursive: true })
    writeFileSync(join(target, '.codex', 'auth.json'), codexAuth(100, 'stale-target', ''))

    const fresher = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(200, 'donor', 'donor-refresh')).toString('base64'),
    }
    expect(
      await installPortableCredential(fresher, target, { realHome: true, guarded: true }),
    ).toBe(true)

    writeFileSync(join(target, '.codex', 'auth.json'), codexAuth(200, 'stale-target', ''))
    const older = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(150, 'older', 'older-refresh')).toString('base64'),
    }
    expect(await installPortableCredential(older, target, { realHome: true, guarded: true })).toBe(
      false,
    )

    writeFileSync(join(target, '.codex', 'auth.json'), codexAuth(200, 'stale-target', ''))
    const unknown = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(Number.NaN, 'unknown', 'unknown-refresh')).toString(
        'base64',
      ),
    }
    const beforeUnknown = readFileSync(join(target, '.codex', 'auth.json'), 'utf8')
    expect(
      await installPortableCredential(unknown, target, { realHome: true, guarded: true }),
    ).toBe(false)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toBe(beforeUnknown)
  })

  it.each([
    'linux',
    'win32',
  ] as const)('keeps non-Darwin Claude propagation on the real file backend for %s', async (platform) => {
    const candidate = {
      kind: 'claude-code' as const,
      contentBase64: Buffer.from(claudeAuth(200, 'donor', 'donor-refresh')).toString('base64'),
    }
    expect(
      await installPortableCredential(candidate, target, {
        platform,
        env: { CLAUDE_CONFIG_DIR: join(target, 'managed-claude') },
        realHome: true,
        guarded: true,
      }),
    ).toBe(true)
    expect(readFileSync(join(target, '.claude', '.credentials.json'), 'utf8')).toContain('donor')
    expect(() => readFileSync(join(target, 'managed-claude', '.credentials.json'))).toThrow()
  })
})

function result(overrides: Partial<SecurityResult> = {}): SecurityResult {
  return {
    stdout: Buffer.alloc(0),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  }
}

class FakeSecurityRunner implements SecurityRunner {
  readonly calls: Array<{ args: readonly string[]; input?: string }> = []

  constructor(private readonly results: SecurityResult[]) {}

  async run(args: readonly string[], input?: Buffer): Promise<SecurityResult> {
    this.calls.push({ args: [...args], ...(input ? { input: input.toString('ascii') } : {}) })
    const next = this.results.shift()
    if (!next) throw new Error('unexpected security call')
    return next
  }
}

const absent = () =>
  result({
    exitCode: 44,
    stderr:
      'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
  })

const present = (content: string) =>
  result({ stdout: Buffer.concat([Buffer.from(content), Buffer.from('\n')]) })

describe('Darwin Claude Keychain routing', () => {
  it('exports a guarded native credential from Keychain instead of the file path', async () => {
    const secret = claudeAuth(200, 'synthetic-access', 'synthetic-refresh')
    const runner = new FakeSecurityRunner([present(secret)])
    const bundle = await readPortableCredential('claude-code', source, {
      platform: 'darwin',
      env: { USER: 'native-user' },
      osUsername: 'fallback-user',
      securityRunner: runner,
      guarded: true,
      realHome: true,
    })
    expect(Buffer.from(bundle?.contentBase64 ?? '', 'base64').toString()).toBe(secret)
    expect(runner.calls[0]?.args).toEqual([
      'find-generic-password',
      '-a',
      'native-user',
      '-s',
      'Claude Code-credentials',
      '-w',
    ])
    expect(() => readFileSync(join(source, '.claude', '.credentials.json'))).toThrow()
  })

  it('installs only after the supported version, second read, stdin write, and readback', async () => {
    const secret = claudeAuth(200, 'synthetic-access', 'synthetic-refresh')
    const runner = new FakeSecurityRunner([absent(), absent(), result(), present(secret)])
    expect(
      await installPortableCredential(
        { kind: 'claude-code', contentBase64: Buffer.from(secret).toString('base64') },
        target,
        {
          platform: 'darwin',
          env: { USER: 'native-user' },
          osUsername: 'fallback-user',
          resolvedClaudeVersion: '2.1.234 (Claude Code)',
          securityRunner: runner,
          claudeLockFactory: async () => ({
            compromised: false,
            release: vi.fn(async () => {}),
          }),
          guarded: true,
          realHome: true,
        },
      ),
    ).toBe(true)
    expect(runner.calls[2]?.args).toEqual(['-i'])
    expect(runner.calls[2]?.args.join(' ')).not.toContain('synthetic-access')
    expect(runner.calls[2]?.input).not.toContain('synthetic-access')
  })
})

describe('credential handlers', () => {
  it('uses one current runtime snapshot, awaits the stores, and emits one result frame', async () => {
    mkdirSync(join(source, '.codex'), { recursive: true })
    writeFileSync(join(source, '.codex', 'auth.json'), codexAuth(200))
    const current = vi.fn(async () => ({
      commandEnvironment: { env: { PATH: '/usr/bin', USER: 'native-user' } },
      executables: new Map([['claude-code', { version: '2.1.234 (Claude Code)' }]]),
    }))
    const send = vi.fn()
    const ctx = {
      homeDir: source,
      harnessRuntime: { current },
      send,
    } as unknown as DaemonContext

    await handleCredentialExport(ctx, {
      type: 'credentialExportRequest',
      requestId: 'request-1',
      kinds: ['codex', 'grok'],
      propagation: true,
    })

    expect(current).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({
      type: 'credentialExportResult',
      requestId: 'request-1',
      bundles: [expect.objectContaining({ kind: 'codex' })],
      unavailable: ['grok'],
    })
  })
})
