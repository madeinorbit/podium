import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeKeychainSeams } from '../adapters/claude-code/credentials.js'
import type { ClaudeStorageLockFactory } from '../adapters/claude-code/keychain-lock.js'
import type { SecurityResult, SecurityRunner } from '../adapters/claude-code/keychain-security.js'
import {
  handleCredentialExport,
  handleCredentialInstall,
  installPortableCredential,
  PreservedLoginError,
  readPortableCredential,
} from './credentials.js'

let source: string
let target: string

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), 'podium-credential-source-'))
  target = mkdtempSync(join(tmpdir(), 'podium-credential-target-'))
})

afterEach(() => {
  rmSync(source, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
  delete claudeKeychainSeams.runner
  delete claudeKeychainSeams.lockFactory
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
    claudeKeychainSeams.runner = new FakeSecurityRunner([present(secret)])
    const bundle = await readPortableCredential('claude-code', source, {
      platform: 'darwin',
      env: { USER: 'native-user' },
      osUsername: 'fallback-user',
      guarded: true,
      realHome: true,
    })
    expect(Buffer.from(bundle?.contentBase64 ?? '', 'base64').toString()).toBe(secret)
    expect((claudeKeychainSeams.runner as FakeSecurityRunner).calls[0]?.args).toEqual([
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
    claudeKeychainSeams.runner = new FakeSecurityRunner([
      absent(),
      absent(),
      result(),
      present(secret),
    ])
    claudeKeychainSeams.lockFactory = (async () => ({
      compromised: false,
      release: vi.fn(async () => {}),
    })) as ClaudeStorageLockFactory
    expect(
      await installPortableCredential(
        { kind: 'claude-code', contentBase64: Buffer.from(secret).toString('base64') },
        target,
        {
          platform: 'darwin',
          env: { USER: 'native-user' },
          osUsername: 'fallback-user',
          versions: new Map([['claude-code', '2.1.234 (Claude Code)']]),
          guarded: true,
          realHome: true,
        },
      ),
    ).toBe(true)
    const calls = (claudeKeychainSeams.runner as FakeSecurityRunner).calls
    expect(calls[2]?.args).toEqual(['-i'])
    expect(calls[2]?.args.join(' ')).not.toContain('synthetic-access')
    expect(calls[2]?.input).not.toContain('synthetic-access')
  })
})

describe('inventory credential fixtures (fresh / stale / absent / foreign-env)', () => {
  const FRESH: Record<string, string> = {
    'claude-code': claudeAuth(200),
    codex: codexAuth(200),
    grok: JSON.stringify({ 'default-entry': { key: 'grok-key', email: 'a@b.c' } }),
  }
  const STALE: Record<string, string> = {
    'claude-code': JSON.stringify({ claudeAiOauth: { accessToken: 'orphan' } }),
    codex: codexAuth(100, 'stale-target', ''),
    grok: JSON.stringify({ 'default-entry': { email: 'a@b.c' } }),
  }
  const LAYOUT: Record<string, { dir: string; file: string; envVar: string }> = {
    'claude-code': { dir: '.claude', file: '.credentials.json', envVar: 'CLAUDE_CONFIG_DIR' },
    codex: { dir: '.codex', file: 'auth.json', envVar: 'CODEX_HOME' },
    grok: { dir: '.grok', file: 'auth.json', envVar: 'GROK_HOME' },
  }

  it.each([
    'claude-code',
    'codex',
    'grok',
  ] as const)('reads a fresh %s login through the Inventory section', async (kind) => {
    const { dir, file } = LAYOUT[kind] as { dir: string; file: string }
    mkdirSync(join(source, dir), { recursive: true })
    writeFileSync(join(source, dir, file), FRESH[kind] as string)
    const bundle = await readPortableCredential(kind, source)
    expect(bundle?.kind).toBe(kind)
  })

  it.each([
    'claude-code',
    'codex',
    'grok',
  ] as const)('refuses a stale %s login under the propagation guard', async (kind) => {
    const { dir, file } = LAYOUT[kind] as { dir: string; file: string }
    mkdirSync(join(source, dir), { recursive: true })
    writeFileSync(join(source, dir, file), STALE[kind] as string)
    await expect(readPortableCredential(kind, source, { guarded: true })).resolves.toBeNull()
  })

  it.each([
    'claude-code',
    'codex',
    'grok',
  ] as const)('reports an absent %s credential as null, never as an error', async (kind) => {
    await expect(readPortableCredential(kind, source)).resolves.toBeNull()
  })

  it.each([
    'claude-code',
    'codex',
    'grok',
  ] as const)('honours the %s home redirect, except under a real-home read', async (kind) => {
    const { dir, file, envVar } = LAYOUT[kind] as {
      dir: string
      file: string
      envVar: string
    }
    const redirected = join(source, 'managed-home', dir)
    mkdirSync(redirected, { recursive: true })
    writeFileSync(join(redirected, file), FRESH[kind] as string)
    const env = { [envVar]: redirected }
    const bundle = await readPortableCredential(kind, source, { env })
    expect(bundle?.kind).toBe(kind)
    await expect(readPortableCredential(kind, source, { env, realHome: true })).resolves.toBeNull()
  })
})

describe('credential handlers', () => {
  it('uses one current runtime snapshot and returns one result payload', async () => {
    mkdirSync(join(source, '.codex'), { recursive: true })
    writeFileSync(join(source, '.codex', 'auth.json'), codexAuth(200))
    const current = vi.fn(async () => ({
      env: { PATH: '/usr/bin', USER: 'native-user' },
      versions: new Map([['claude-code', '2.1.234 (Claude Code)']]),
    }))
    const reportInventory = vi.fn()
    const ports = { homeDir: source, snapshotRuntime: current, reportInventory }

    const exported = await handleCredentialExport(ports, {
      requestId: 'request-1',
      kinds: ['codex', 'grok'],
      propagation: true,
    })

    expect(current).toHaveBeenCalledOnce()
    expect(exported).toEqual({
      type: 'credentialExportResult',
      requestId: 'request-1',
      bundles: [expect.objectContaining({ kind: 'codex' })],
      unavailable: ['grok'],
    })

    const installed = await handleCredentialInstall(ports, {
      requestId: 'request-2',
      bundles: exported.bundles,
      propagation: true,
    })
    expect(installed).toEqual({
      type: 'credentialInstallResult',
      requestId: 'request-2',
      installed: [],
      failed: ['codex'],
    })
    // The donor copy is already valid locally, so the guarded install refuses
    // and no inventory re-probe is requested.
    expect(reportInventory).not.toHaveBeenCalled()
  })

  it('re-probes inventory after a fresh install lands', async () => {
    const reportInventory = vi.fn()
    const ports = {
      homeDir: target,
      snapshotRuntime: async () => undefined,
      reportInventory,
    }
    const candidate = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAuth(200, 'donor', 'donor-refresh')).toString('base64'),
    }
    const installed = await handleCredentialInstall(ports, {
      requestId: 'request-3',
      bundles: [candidate],
      propagation: true,
    })
    expect(installed.installed).toEqual(['codex'])
    expect(reportInventory).toHaveBeenCalledOnce()
  })
})

/**
 * POD-6301: a ticked login is copied only as the account the owner ticked, and
 * a destination holding a different (or unknown) login keeps it.
 */
describe('identity-checked native propagation', () => {
  const previousCodexHome = process.env.CODEX_HOME
  beforeEach(() => {
    delete process.env.CODEX_HOME
  })
  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  })

  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const codexAs = (account: string | undefined, freshness: number, access = account ?? 'anon') =>
    JSON.stringify({
      tokens: {
        ...(account ? { account_id: account } : {}),
        access_token: access,
        refresh_token: `${access}-refresh`,
        expires_at: freshness,
      },
    })
  const writeCodex = (home: string, contents: string) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), contents)
  }
  const guarded = (expectedFingerprint: string) => ({
    realHome: true,
    guarded: true,
    expectedFingerprint,
  })
  const alice = sha('acct-alice')

  it('exports only when the local login is still the ticked account', async () => {
    writeCodex(source, codexAs('acct-alice', 200))
    expect(await readPortableCredential('codex', source, guarded(alice))).not.toBeNull()
    writeCodex(source, codexAs('acct-other', 200))
    expect(await readPortableCredential('codex', source, guarded(alice))).toBeNull()
  })

  it('installs into an empty slot', async () => {
    const bundle = await (async () => {
      writeCodex(source, codexAs('acct-alice', 200))
      return await readPortableCredential('codex', source, guarded(alice))
    })()
    if (!bundle) throw new Error('bundle missing')
    expect(await installPortableCredential(bundle, target, guarded(alice))).toBe(true)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toContain('acct-alice')
  })

  it.each([
    ['a different valid login', codexAs('acct-bob', 300)],
    ['a different expired login', codexAs('acct-bob', 100, '')],
    ['a login of unknown identity', codexAs(undefined, 100, '')],
  ])('keeps %s on the destination and says so', async (_label, local) => {
    writeCodex(target, local)
    const bundle = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAs('acct-alice', 500)).toString('base64'),
    }
    await expect(installPortableCredential(bundle, target, guarded(alice))).rejects.toThrow(
      PreservedLoginError,
    )
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toBe(local)

    const reply = await handleCredentialInstall(
      { homeDir: target, snapshotRuntime: async () => undefined, reportInventory: () => {} },
      { requestId: 'r', bundles: [bundle], propagation: true, expectedFingerprint: alice },
    )
    expect(reply).toMatchObject({ installed: [], failed: ['codex'], preserved: ['codex'] })
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toBe(local)
  })

  it('refreshes an expired copy of the same account', async () => {
    writeCodex(target, codexAs('acct-alice', 100, ''))
    const bundle = {
      kind: 'codex' as const,
      contentBase64: Buffer.from(codexAs('acct-alice', 500, 'fresh')).toString('base64'),
    }
    expect(await installPortableCredential(bundle, target, guarded(alice))).toBe(true)
    expect(readFileSync(join(target, '.codex', 'auth.json'), 'utf8')).toContain('fresh')
  })
})
