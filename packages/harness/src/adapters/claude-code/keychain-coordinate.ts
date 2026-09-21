import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const CLAUDE_KEYCHAIN_BASE_SERVICE = 'Claude Code-credentials'
export const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT = 'claude-code-user'

const SAFE_ACCOUNT = /^[A-Za-z0-9._-]+$/

export interface ClaudeKeychainCoordinateOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly osUsername?: string
}

export interface ClaudeKeychainCoordinate {
  readonly account: string
  readonly service: string
  /** Directory on which Claude calls proper-lockfile for `.storage-write`. */
  readonly storageDirectory: string
  readonly scoped: boolean
}

export function claudeKeychainAccount(
  env: Readonly<Record<string, string | undefined>>,
  osUsername?: string,
): string {
  const commandUser = env.USER
  if (commandUser && SAFE_ACCOUNT.test(commandUser)) return commandUser
  if (osUsername && SAFE_ACCOUNT.test(osUsername)) return osUsername
  return CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT
}

export function normalizeClaudeStorageDirectory(value: string): string {
  // Verified against Claude Code 2.1.234. Do not resolve paths, expand `~`,
  // collapse `..`, remove trailing slashes, or otherwise reinterpret the text.
  return value.normalize('NFC')
}

export function claudeKeychainService(env: Readonly<Record<string, string | undefined>>): {
  readonly service: string
  readonly scoped: boolean
} {
  const secureDirectory = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const configDirectory = env.CLAUDE_CONFIG_DIR
  const explicit = secureDirectory !== undefined ? secureDirectory : configDirectory
  if (!explicit) return { service: CLAUDE_KEYCHAIN_BASE_SERVICE, scoped: false }
  const normalized = normalizeClaudeStorageDirectory(explicit)
  const hash8 = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  return { service: `${CLAUDE_KEYCHAIN_BASE_SERVICE}-${hash8}`, scoped: true }
}

export function deriveClaudeKeychainCoordinate(
  options: ClaudeKeychainCoordinateOptions,
): ClaudeKeychainCoordinate {
  const derived = claudeKeychainService(options.env)
  const secureDirectory = options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const configDirectory = options.env.CLAUDE_CONFIG_DIR
  const storageDirectory =
    secureDirectory !== undefined
      ? normalizeClaudeStorageDirectory(secureDirectory || join(options.home, '.claude'))
      : normalizeClaudeStorageDirectory(configDirectory ?? join(options.home, '.claude'))
  return {
    account: claudeKeychainAccount(options.env, options.osUsername),
    service: derived.service,
    storageDirectory,
    scoped: derived.scoped,
  }
}
