import { describe, expect, it } from 'vitest'
import { declaredValue } from '../../manifest.js'
import { claudeCredentials, sanitizedClaudeState } from './credentials.js'
import { ClaudeKeychainCredentialStore } from './keychain-credential-store.js'

describe('claudeCredentials section', () => {
  it('serves the credential and state bundles with their guards', () => {
    expect(claudeCredentials.kinds).toEqual(['claude-code', 'claude-code-state'])
    const [credential, state] = claudeCredentials.files
    expect(credential).toMatchObject({
      kind: 'claude-code',
      dirName: '.claude',
      fileName: '.credentials.json',
      homeEnvVar: 'CLAUDE_CONFIG_DIR',
      propagatable: true,
    })
    expect(state).toMatchObject({
      kind: 'claude-code-state',
      propagatable: false,
      mergeInstall: true,
    })
    expect(typeof state?.sanitize).toBe('function')
  })

  it('resolves identity from the state file only', () => {
    const identity = claudeCredentials.identity((dir, file) =>
      dir === '' && file === '.claude.json'
        ? JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } })
        : undefined,
    )
    expect(identity?.email).toBe('a@b.c')
    expect(identity?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(claudeCredentials.identity(() => undefined)).toBeUndefined()
  })

  it('routes the credential file to the keychain on darwin, and nowhere else', () => {
    const transfer = declaredValue(claudeCredentials.transfer)
    expect(transfer).toBeDefined()
    const base = {
      home: '/fake/home',
      env: {},
      versions: new Map(),
      file: claudeCredentials.files[0]!,
      fileAbsolutePath: '/fake/home/.claude/.credentials.json',
    }
    expect(transfer?.createStore({ ...base, platform: 'darwin' })).toBeInstanceOf(
      ClaudeKeychainCredentialStore,
    )
    expect(transfer?.createStore({ ...base, platform: 'linux' })).toBeUndefined()
    // The state file never leaves the file backend, even on darwin.
    expect(
      transfer?.createStore({
        ...base,
        platform: 'darwin',
        file: claudeCredentials.files[1]!,
        fileAbsolutePath: '/fake/home/.claude.json',
      }),
    ).toBeUndefined()
  })
})

describe('sanitizedClaudeState', () => {
  it('projects onboarding markers and drops machine identity', () => {
    expect(
      sanitizedClaudeState({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.92',
        installMethod: 'native',
        machineID: 'must-not-cross-machines',
        oauthAccount: { emailAddress: 'must-not-cross' },
      }),
    ).toEqual({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.92',
      installMethod: 'native',
    })
  })

  it('rejects incomplete onboarding and non-objects', () => {
    expect(() => sanitizedClaudeState({ hasCompletedOnboarding: false })).toThrow()
    expect(() => sanitizedClaudeState(null)).toThrow()
    expect(() => sanitizedClaudeState([])).toThrow()
  })
})
