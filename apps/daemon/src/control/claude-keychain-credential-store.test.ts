import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeKeychainCredentialStore,
  supportsClaudeKeychainMutation,
} from './claude-keychain-credential-store'
import type { ClaudeStorageWriteLock } from './claude-keychain-lock'
import type { SecurityResult, SecurityRunner } from './claude-keychain-security'
import type { GuardedCredentialPolicy } from './credential-store'

interface SecurityCall {
  readonly args: readonly string[]
  readonly input?: string
}

function securityResult(overrides: Partial<SecurityResult> = {}): SecurityResult {
  return {
    stdout: Buffer.alloc(0),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  }
}

function present(value: string | Buffer): SecurityResult {
  const content = typeof value === 'string' ? Buffer.from(value) : value
  return securityResult({ stdout: Buffer.concat([content, Buffer.from('\n')]) })
}

function absent(): SecurityResult {
  return securityResult({
    exitCode: 44,
    stderr:
      'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
  })
}

class QueueSecurityRunner implements SecurityRunner {
  readonly calls: SecurityCall[] = []

  constructor(private readonly results: SecurityResult[]) {}

  async run(args: readonly string[], input?: Buffer): Promise<SecurityResult> {
    this.calls.push({ args: [...args], ...(input ? { input: input.toString('ascii') } : {}) })
    const result = this.results.shift()
    if (!result) throw new Error('unexpected security invocation')
    return result
  }
}

function unlocked(): ClaudeStorageWriteLock {
  return { compromised: false, release: vi.fn(async () => {}) }
}

const policy: GuardedCredentialPolicy = {
  valid(value) {
    return (JSON.parse(value) as { valid?: boolean }).valid === true
  },
  compareFreshness(candidate, current) {
    const candidateValue = (JSON.parse(candidate) as { freshness?: number }).freshness
    const currentValue = (JSON.parse(current) as { freshness?: number }).freshness
    if (candidateValue === undefined || currentValue === undefined) return null
    return Math.sign(candidateValue - currentValue)
  },
}

function store(
  runner: SecurityRunner,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly version?: string
    readonly lock?: () => Promise<ClaudeStorageWriteLock>
  } = {},
): ClaudeKeychainCredentialStore {
  return new ClaudeKeychainCredentialStore({
    home: '/Users/native',
    env: options.env ?? { USER: 'native-user' },
    osUsername: 'fallback-user',
    resolvedClaudeVersion: options.version ?? '2.1.234 (Claude Code)',
    runner,
    ...(options.lock ? { lockFactory: options.lock } : { lockFactory: async () => unlocked() }),
  })
}

describe('Claude Keychain reads', () => {
  it('uses exact separate read argv for the derived scoped coordinate', async () => {
    const value = '{"valid":true,"freshness":2}'
    const runner = new QueueSecurityRunner([present(value)])
    const read = await store(runner, {
      env: { USER: 'native-user', CLAUDE_CONFIG_DIR: '/tmp/claude' },
    }).read()
    expect(read.state).toBe('present')
    if (read.state === 'present') {
      expect(read.contents.toString()).toBe(value)
      read.contents.fill(0)
    }
    expect(runner.calls).toEqual([
      {
        args: [
          'find-generic-password',
          '-a',
          'native-user',
          '-s',
          'Claude Code-credentials-21493821',
          '-w',
        ],
      },
    ])
  })

  it('falls back from a genuinely absent scoped item to the legacy base service', async () => {
    const runner = new QueueSecurityRunner([absent(), present('{"valid":true}')])
    const read = await store(runner, { env: { CLAUDE_CONFIG_DIR: '/tmp/claude' } }).read()
    expect(read.state).toBe('present')
    if (read.state === 'present') read.contents.fill(0)
    expect(runner.calls.map((call) => call.args[4])).toEqual([
      'Claude Code-credentials-21493821',
      'Claude Code-credentials',
    ])
  })

  it.each([
    securityResult({ exitCode: 1, stderr: 'User interaction is not allowed.' }),
    securityResult({ exitCode: 1, stderr: 'keychain is locked' }),
    securityResult({ exitCode: null, timedOut: true }),
    securityResult({ exitCode: null, signal: 'SIGKILL' }),
    securityResult({ exitCode: null, overflowed: true }),
    securityResult({ exitCode: null, failedToSpawn: true }),
  ])('never treats unavailable scoped state as absence', async (failure) => {
    const runner = new QueueSecurityRunner([failure])
    const read = await store(runner, { env: { CLAUDE_CONFIG_DIR: '/tmp/claude' } }).read()
    expect(read.state).toBe('unavailable')
    expect(runner.calls).toHaveLength(1)
  })

  it('requires the captured exit and diagnostic together for item-not-found', async () => {
    const runner = new QueueSecurityRunner([
      securityResult({ exitCode: 44, stderr: 'some other failure' }),
    ])
    expect((await store(runner).read()).state).toBe('unavailable')
  })

  it.each([
    Buffer.from('not-json'),
    Buffer.from('["not-an-object"]'),
    Buffer.from([0xff, 0xfe]),
  ])('fails closed for malformed successful output', async (output) => {
    const runner = new QueueSecurityRunner([present(output)])
    const read = await store(runner).read()
    expect(read).toEqual({ state: 'unavailable', reason: 'malformed-output' })
  })
})

describe('Claude Keychain guarded installs', () => {
  it('refuses a valid local credential before acquiring a lock or writing', async () => {
    const lock = vi.fn(async () => unlocked())
    const runner = new QueueSecurityRunner([present('{"valid":true,"freshness":300}')])
    expect(
      await store(runner, { lock }).guardedInstall(
        Buffer.from('{"valid":true,"freshness":200}'),
        policy,
      ),
    ).toBe(false)
    expect(lock).not.toHaveBeenCalled()
    expect(runner.calls).toHaveLength(1)
  })

  it('requires strict comparable freshness for invalid occupied content', async () => {
    const runner = new QueueSecurityRunner([present('{"valid":false,"freshness":200}')])
    expect(
      await store(runner).guardedInstall(Buffer.from('{"valid":true,"freshness":200}'), policy),
    ).toBe(false)
    expect(runner.calls).toHaveLength(1)
  })

  it('fences a changed second read under the cooperative lock', async () => {
    const runner = new QueueSecurityRunner([absent(), present('{"valid":false,"freshness":100}')])
    expect(
      await store(runner).guardedInstall(Buffer.from('{"valid":true,"freshness":200}'), policy),
    ).toBe(false)
    expect(runner.calls).toHaveLength(2)
  })

  it('uses the verified locked -U write, exact readback, and releases the lock', async () => {
    const candidate = '{"valid":true,"freshness":200,"token":"synthetic-secret"}'
    const held = unlocked()
    const runner = new QueueSecurityRunner([
      present('{"valid":false,"freshness":100}'),
      present('{"valid":false,"freshness":100}'),
      securityResult(),
      present(candidate),
    ])
    expect(
      await store(runner, { lock: async () => held }).guardedInstall(
        Buffer.from(candidate),
        policy,
      ),
    ).toBe(true)
    expect(held.release).toHaveBeenCalledOnce()
    expect(runner.calls[2]?.args).toEqual(['-i'])
    expect(runner.calls[2]?.args.join(' ')).not.toContain('synthetic-secret')
    expect(runner.calls[2]?.input).toContain('add-generic-password -U')
    expect(runner.calls[2]?.input).toContain(Buffer.from(candidate).toString('hex'))
    expect(runner.calls[2]?.input).not.toContain('synthetic-secret')
    expect(runner.calls[2]?.input).not.toMatch(/(?:^|\s)-A(?:\s|$)/)
  })

  it('reports a readback mismatch as failure', async () => {
    const candidate = '{"valid":true,"freshness":200}'
    const runner = new QueueSecurityRunner([
      absent(),
      absent(),
      securityResult(),
      present('{"valid":true,"freshness":201}'),
    ])
    expect(await store(runner).guardedInstall(Buffer.from(candidate), policy)).toBe(false)
  })

  it('falls back to atomic create-only when the cooperative lock is unavailable', async () => {
    const candidate = '{"valid":true,"freshness":200}'
    const runner = new QueueSecurityRunner([
      absent(),
      absent(),
      securityResult(),
      present(candidate),
    ])
    expect(
      await store(runner, {
        lock: async () => {
          throw new Error('contended')
        },
      }).guardedInstall(Buffer.from(candidate), policy),
    ).toBe(true)
    expect(runner.calls[2]?.input).toContain('add-generic-password -a')
    expect(runner.calls[2]?.input).not.toContain(' -U ')
  })

  it('leaves an occupied target unchanged when no cooperative lock can be acquired', async () => {
    const runner = new QueueSecurityRunner([present('{"valid":false,"freshness":100}')])
    expect(
      await store(runner, {
        lock: async () => {
          throw new Error('contended')
        },
      }).guardedInstall(Buffer.from('{"valid":true,"freshness":200}'), policy),
    ).toBe(false)
    expect(runner.calls).toHaveLength(1)
  })

  it('treats a create-only duplicate as concurrent occupation', async () => {
    const runner = new QueueSecurityRunner([
      absent(),
      absent(),
      securityResult({ exitCode: 45, stderr: 'errSecDuplicateItem: already exists' }),
    ])
    expect(
      await store(runner, {
        lock: async () => {
          throw new Error('contended')
        },
      }).guardedInstall(Buffer.from('{"valid":true,"freshness":200}'), policy),
    ).toBe(false)
    expect(runner.calls).toHaveLength(3)
  })

  it('refuses unsupported versions before invoking the security runner', async () => {
    const runner = new QueueSecurityRunner([])
    expect(
      await store(runner, { version: '2.2.0 (Claude Code)' }).guardedInstall(
        Buffer.from('{"valid":true,"freshness":200}'),
        policy,
      ),
    ).toBe(false)
    expect(runner.calls).toEqual([])
  })
})

describe('Claude mutation version gate', () => {
  it.each([
    '2.1.0',
    '2.1.234 (Claude Code)',
    ' 2.1.999 ',
  ])('accepts verified 2.1.x: %s', (version) => {
    expect(supportsClaudeKeychainMutation(version)).toBe(true)
  })

  it.each([
    undefined,
    '',
    '2.0.99',
    '2.2.0',
    'not-a-version',
  ])('rejects uncovered versions: %s', (version) => {
    expect(supportsClaudeKeychainMutation(version)).toBe(false)
  })
})
