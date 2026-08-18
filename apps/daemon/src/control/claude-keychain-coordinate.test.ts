import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_KEYCHAIN_BASE_SERVICE,
  claudeKeychainAccount,
  claudeKeychainService,
  deriveClaudeKeychainCoordinate,
} from './claude-keychain-coordinate'
import { acquireClaudeStorageWriteLock, CLAUDE_STORAGE_LOCK_CONTRACT } from './claude-keychain-lock'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Claude Keychain coordinates from Claude Code 2.1.234', () => {
  it('selects a safe command USER, then OS username, then the compatibility fallback', () => {
    expect(claudeKeychainAccount({ USER: 'native.user-1' }, 'os-user')).toBe('native.user-1')
    expect(claudeKeychainAccount({ USER: 'not safe!' }, 'os-user')).toBe('os-user')
    expect(claudeKeychainAccount({ USER: '' }, 'also unsafe!')).toBe('claude-code-user')
  })

  it.each([
    [{}, CLAUDE_KEYCHAIN_BASE_SERVICE],
    [{ CLAUDE_CONFIG_DIR: '' }, CLAUDE_KEYCHAIN_BASE_SERVICE],
    [{ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, CLAUDE_KEYCHAIN_BASE_SERVICE],
    [{ CLAUDE_CONFIG_DIR: '/tmp/claude' }, 'Claude Code-credentials-21493821'],
    [{ CLAUDE_CONFIG_DIR: 'relative/path' }, 'Claude Code-credentials-fdc1a528'],
    [{ CLAUDE_CONFIG_DIR: '/tmp/claude/' }, 'Claude Code-credentials-2958cf24'],
    [{ CLAUDE_CONFIG_DIR: 'relative/../claude' }, 'Claude Code-credentials-b4948cfa'],
    [{ CLAUDE_CONFIG_DIR: '~/claude' }, 'Claude Code-credentials-1b9cf744'],
    [{ CLAUDE_CONFIG_DIR: 'é' }, 'Claude Code-credentials-4a99557e'],
    [{ CLAUDE_CONFIG_DIR: 'e\u0301' }, 'Claude Code-credentials-4a99557e'],
  ])('derives the golden service for %j without path reinterpretation', (env, service) => {
    expect(claudeKeychainService(env)).toEqual({
      service,
      scoped: service !== CLAUDE_KEYCHAIN_BASE_SERVICE,
    })
  })

  it('gives the secure-storage directory precedence for service and lock placement', () => {
    expect(
      deriveClaudeKeychainCoordinate({
        home: '/Users/native',
        env: {
          USER: 'native',
          CLAUDE_CONFIG_DIR: '/ignored',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: 'e\u0301',
        },
        osUsername: 'fallback',
      }),
    ).toEqual({
      account: 'native',
      service: 'Claude Code-credentials-4a99557e',
      storageDirectory: 'é',
      scoped: true,
    })
  })

  it('uses the native home for an explicitly empty secure-storage directory', () => {
    expect(
      deriveClaudeKeychainCoordinate({
        home: '/Users/native',
        env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
        osUsername: 'native',
      }).storageDirectory,
    ).toBe('/Users/native/.claude')
  })
})

describe('Claude 2.1.234 .storage-write lock contract', () => {
  it('records the captured proper-lockfile options', () => {
    expect(CLAUDE_STORAGE_LOCK_CONTRACT).toEqual({
      targetName: '.storage-write',
      artifactName: '.storage-write.lock',
      staleMs: 15_000,
      updateMs: 7_500,
      retries: 10,
      minRetryMs: 100,
      maxRetryMs: 1_000,
      artifactKind: 'directory',
      payload: 'none',
    })
  })

  it('acquires an empty directory artifact and removes it on release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'podium-claude-lock-'))
    temporaryDirectories.push(directory)
    const lock = await acquireClaudeStorageWriteLock(directory)
    const artifact = join(directory, '.storage-write.lock')
    expect(lstatSync(artifact).isDirectory()).toBe(true)
    expect(readdirSync(artifact)).toEqual([])
    expect(lock.compromised).toBe(false)
    await lock.release()
    expect(() => lstatSync(artifact)).toThrow()
  })
})
