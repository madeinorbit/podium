import { describe, expect, it, vi } from 'vitest'
import { ClaudeKeychainCredentialStore } from './claude-keychain-credential-store'
import type { ClaudeStorageWriteLock } from './claude-keychain-lock'
import type { SecurityResult, SecurityRunner } from './claude-keychain-security'
import type { GuardedCredentialPolicy } from './credential-store'

type InstallMode = 'guarded' | 'unguarded'

function result(overrides: Partial<SecurityResult> = {}): SecurityResult {
  return {
    stdout: Buffer.alloc(0),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  }
}

function absent(): SecurityResult {
  return result({
    exitCode: 44,
    stderr:
      'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
  })
}

function present(value: string): SecurityResult {
  return result({ stdout: Buffer.from(`${value}\n`) })
}

class QueueRunner implements SecurityRunner {
  constructor(private readonly results: SecurityResult[]) {}

  async run(): Promise<SecurityResult> {
    const next = this.results.shift()
    if (!next) throw new Error('unexpected security invocation')
    return next
  }
}

const policy: GuardedCredentialPolicy = {
  valid(value) {
    return (JSON.parse(value) as { valid?: boolean }).valid === true
  },
  compareFreshness(candidate, current) {
    const next = (JSON.parse(candidate) as { freshness: number }).freshness
    const previous = (JSON.parse(current) as { freshness: number }).freshness
    return Math.sign(next - previous)
  },
}

async function installWithLock(mode: InstallMode, lock: ClaudeStorageWriteLock): Promise<boolean> {
  const candidate = '{"valid":true,"freshness":200,"token":"synthetic-only"}'
  const runner = new QueueRunner([absent(), absent(), result(), present(candidate)])
  const credentialStore = new ClaudeKeychainCredentialStore({
    home: '/Users/native',
    env: { USER: 'native-user' },
    osUsername: 'fallback-user',
    resolvedClaudeVersion: '2.1.234 (Claude Code)',
    runner,
    lockFactory: async () => lock,
  })
  const content = Buffer.from(candidate)
  return mode === 'guarded'
    ? credentialStore.guardedInstall(content, policy)
    : credentialStore.install(content)
}

for (const mode of ['guarded', 'unguarded'] as const) {
  describe(`${mode} locked Keychain installs`, () => {
    it('does not swallow a release failure after a verified write', async () => {
      const release = vi.fn(async () => {
        throw new Error('synthetic release failure')
      })
      const lock: ClaudeStorageWriteLock = { compromised: false, release }

      await expect(installWithLock(mode, lock)).rejects.toThrow('synthetic release failure')
      expect(release).toHaveBeenCalledOnce()
    })

    it('reports failure when release reveals a compromised lock', async () => {
      let compromised = false
      const release = vi.fn(async () => {
        compromised = true
      })
      const lock: ClaudeStorageWriteLock = {
        get compromised() {
          return compromised
        },
        release,
      }

      await expect(installWithLock(mode, lock)).resolves.toBe(false)
      expect(release).toHaveBeenCalledOnce()
    })
  })
}
