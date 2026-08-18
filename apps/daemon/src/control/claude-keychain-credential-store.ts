import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import {
  CLAUDE_KEYCHAIN_BASE_SERVICE,
  deriveClaudeKeychainCoordinate,
  type ClaudeKeychainCoordinate,
} from './claude-keychain-coordinate'
import {
  acquireClaudeStorageWriteLock,
  type ClaudeStorageLockFactory,
  type ClaudeStorageWriteLock,
} from './claude-keychain-lock'
import {
  claudeKeychainWriteInput,
  productionSecurityRunner,
  type SecurityResult,
  type SecurityRunner,
} from './claude-keychain-security'
import {
  MAX_CREDENTIAL_BYTES,
  type CredentialReadResult,
  type CredentialStoreFailure,
  type GuardedCredentialPolicy,
  type PortableCredentialStore,
} from './credential-store'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const ITEM_NOT_FOUND = 'The specified item could not be found in the keychain.'

export interface ClaudeKeychainCredentialStoreOptions {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly osUsername?: string
  readonly resolvedClaudeVersion?: string
  readonly runner?: SecurityRunner
  readonly lockFactory?: ClaudeStorageLockFactory
  readonly allowLegacyFallback?: boolean
}

function failureFrom(result: SecurityResult): CredentialStoreFailure {
  if (result.timedOut) return 'timeout'
  if (result.overflowed) return 'output-overflow'
  if (result.failedToSpawn || result.signal) return 'tool-failure'
  const diagnostic = result.stderr.toLowerCase()
  if (
    diagnostic.includes('errsecinteractionnotallowed') ||
    diagnostic.includes('interaction is not allowed') ||
    diagnostic.includes('errsecauthfailed') ||
    diagnostic.includes('authorization') ||
    diagnostic.includes('authentication') ||
    diagnostic.includes('locked') ||
    diagnostic.includes('unlock')
  ) {
    return 'locked-or-denied'
  }
  if (
    diagnostic.includes('errsecnodefaultkeychain') ||
    diagnostic.includes('default keychain') ||
    diagnostic.includes('no keychain') ||
    diagnostic.includes('unable to open') ||
    diagnostic.includes('could not open')
  ) {
    return 'keychain-unavailable'
  }
  return 'tool-failure'
}

function itemNotFound(result: SecurityResult): boolean {
  // Captured macOS `security` result: exit 44 with
  // `SecKeychainSearchCopyNext: The specified item could not be found in the keychain.`
  return (
    result.exitCode === 44 &&
    (result.stderr.includes(ITEM_NOT_FOUND) || result.stderr.includes('errSecItemNotFound'))
  )
}

function duplicateItem(result: SecurityResult): boolean {
  if (result.exitCode === 0) return false
  const diagnostic = result.stderr.toLowerCase()
  return diagnostic.includes('errsecduplicateitem') || diagnostic.includes('already exists')
}

function stripSecurityLineEnding(stdout: Buffer): Buffer {
  let end = stdout.length
  if (end > 0 && stdout[end - 1] === 0x0a) end -= 1
  if (end > 0 && stdout[end - 1] === 0x0d) end -= 1
  return Buffer.from(stdout.subarray(0, end))
}

function revision(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function releaseRead(result: CredentialReadResult): void {
  if (result.state === 'present') result.contents.fill(0)
}

function sameRead(a: CredentialReadResult, b: CredentialReadResult): boolean {
  if (a.state !== b.state) return false
  if (a.state === 'absent') return true
  if (a.state !== 'present' || b.state !== 'present') return false
  return a.revision === b.revision
}

function allowedByGuard(
  snapshot: CredentialReadResult,
  content: Buffer,
  policy: GuardedCredentialPolicy,
): boolean {
  if (snapshot.state === 'unavailable') return false
  if (snapshot.state === 'absent') return true
  const current = snapshot.contents.toString('utf8')
  if (policy.valid(current)) return false
  return policy.compareFreshness?.(content.toString('utf8'), current) === 1
}

async function withReleasedLock(
  lock: ClaudeStorageWriteLock,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  let installed = false
  try {
    installed = await operation()
  } finally {
    // A successful write is not complete until Claude's cooperative lock has
    // been cleanly released. Release failures deliberately escape to callers.
    await lock.release()
  }
  return installed && !lock.compromised
}

export function supportsClaudeKeychainMutation(version: string | undefined): boolean {
  return version !== undefined && /^2\.1\.\d+(?:\s|$)/.test(version.trim())
}

const coordinateTails = new Map<string, Promise<void>>()

async function withCoordinateMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = coordinateTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  coordinateTails.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (coordinateTails.get(key) === current) coordinateTails.delete(key)
  }
}

export class ClaudeKeychainCredentialStore implements PortableCredentialStore {
  readonly coordinate: ClaudeKeychainCoordinate
  private readonly runner: SecurityRunner
  private readonly lockFactory: ClaudeStorageLockFactory
  private readonly allowLegacyFallback: boolean

  constructor(private readonly options: ClaudeKeychainCredentialStoreOptions) {
    this.coordinate = deriveClaudeKeychainCoordinate(options)
    this.runner = options.runner ?? productionSecurityRunner
    this.lockFactory = options.lockFactory ?? acquireClaudeStorageWriteLock
    this.allowLegacyFallback = options.allowLegacyFallback ?? true
  }

  async read(): Promise<CredentialReadResult> {
    const authoritative = await this.readService(this.coordinate.service)
    if (authoritative.state !== 'absent' || !this.coordinate.scoped || !this.allowLegacyFallback) {
      return authoritative
    }
    return this.readService(CLAUDE_KEYCHAIN_BASE_SERVICE)
  }

  async install(content: Buffer): Promise<boolean> {
    if (!supportsClaudeKeychainMutation(this.options.resolvedClaudeVersion)) return false
    const key = `${this.coordinate.account}\0${this.coordinate.service}`
    return withCoordinateMutex(key, async () => {
      const before = await this.readAuthoritative()
      try {
        if (before.state === 'unavailable') return false
        const lock = await this.tryLock()
        if (!lock) {
          if (before.state !== 'absent') return false
          const again = await this.readAuthoritative()
          try {
            if (!sameRead(before, again)) return false
            return this.writeAndVerify(content, false)
          } finally {
            releaseRead(again)
          }
        }
        return withReleasedLock(lock, async () => {
          const again = await this.readAuthoritative()
          try {
            if (!sameRead(before, again) || lock.compromised) return false
            return this.writeAndVerify(content, true)
          } finally {
            releaseRead(again)
          }
        })
      } finally {
        releaseRead(before)
      }
    })
  }

  async guardedInstall(content: Buffer, policy: GuardedCredentialPolicy): Promise<boolean> {
    if (!supportsClaudeKeychainMutation(this.options.resolvedClaudeVersion)) return false
    const before = await this.readAuthoritative()
    try {
      if (!allowedByGuard(before, content, policy)) return false
      const key = `${this.coordinate.account}\0${this.coordinate.service}`
      return await withCoordinateMutex(key, async () => {
        const lock = await this.tryLock()
        if (!lock) {
          // Without Claude's cooperative lock, only Keychain's atomic create
          // operation is safe. It can never replace an occupied item.
          if (before.state !== 'absent') return false
          const again = await this.readAuthoritative()
          try {
            if (!sameRead(before, again) || !allowedByGuard(again, content, policy)) return false
            return this.writeAndVerify(content, false)
          } finally {
            releaseRead(again)
          }
        }
        return withReleasedLock(lock, async () => {
          const again = await this.readAuthoritative()
          try {
            if (
              !sameRead(before, again) ||
              !allowedByGuard(again, content, policy) ||
              lock.compromised
            ) {
              return false
            }
            return this.writeAndVerify(content, true)
          } finally {
            releaseRead(again)
          }
        })
      })
    } finally {
      releaseRead(before)
    }
  }

  private async readAuthoritative(): Promise<CredentialReadResult> {
    return this.readService(this.coordinate.service)
  }

  private async readService(service: string): Promise<CredentialReadResult> {
    const result = await this.runner.run([
      'find-generic-password',
      '-a',
      this.coordinate.account,
      '-s',
      service,
      '-w',
    ])
    try {
      if (result.timedOut || result.overflowed || result.failedToSpawn || result.signal) {
        return { state: 'unavailable', reason: failureFrom(result) }
      }
      if (result.exitCode !== 0) {
        return itemNotFound(result)
          ? { state: 'absent' }
          : { state: 'unavailable', reason: failureFrom(result) }
      }
      const contents = stripSecurityLineEnding(result.stdout)
      if (contents.length <= 0 || contents.length > MAX_CREDENTIAL_BYTES) {
        const reason =
          contents.length > MAX_CREDENTIAL_BYTES ? 'output-overflow' : 'malformed-output'
        contents.fill(0)
        return { state: 'unavailable', reason }
      }
      try {
        const decoded = UTF8.decode(contents)
        const parsed = JSON.parse(decoded) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          contents.fill(0)
          return { state: 'unavailable', reason: 'malformed-output' }
        }
      } catch {
        contents.fill(0)
        return { state: 'unavailable', reason: 'malformed-output' }
      }
      return { state: 'present', contents, revision: revision(contents) }
    } finally {
      result.stdout.fill(0)
    }
  }

  private async tryLock(): Promise<ClaudeStorageWriteLock | undefined> {
    try {
      return await this.lockFactory(this.coordinate.storageDirectory)
    } catch {
      return undefined
    }
  }

  private async writeAndVerify(content: Buffer, replace: boolean): Promise<boolean> {
    const input = claudeKeychainWriteInput(
      this.coordinate.account,
      this.coordinate.service,
      content,
      replace,
    )
    let result: SecurityResult
    try {
      result = await this.runner.run(['-i'], input)
    } finally {
      input.fill(0)
    }
    try {
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.overflowed ||
        result.failedToSpawn ||
        result.signal ||
        (!replace && duplicateItem(result))
      ) {
        return false
      }
    } finally {
      result.stdout.fill(0)
    }

    const readback = await this.readAuthoritative()
    try {
      return readback.state === 'present' && readback.contents.equals(content)
    } finally {
      releaseRead(readback)
    }
  }
}
