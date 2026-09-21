/**
 * Claude Code credential + state files — the Inventory credentials section
 * (POD-4414 §4.4, issue 3.3).
 *
 * KNOWLEDGE, not mechanism: which files back which portable bundle, what
 * counts as a valid native login, how two copies order, and the one layout
 * that is genuinely platform-specific code — the macOS keychain branch, a
 * small harness-local strategy behind the section interface (spec principle
 * 4). The inventory mechanism resolves, reads, writes and guards through
 * these declarations without naming the harness.
 */
import { fingerprintForLoginIdentity } from '../../codex-auth-identity.js'
import {
  compareClaudeCredentialFreshness,
  hasValidClaudeCredential,
  readClaudeCredentialFreshness,
} from '../../credential-freshness.js'
import { supported, type HarnessCredentials } from '../../manifest.js'
import { ClaudeKeychainCredentialStore } from './keychain-credential-store.js'
import type { ClaudeStorageLockFactory } from './keychain-lock.js'
import type { SecurityRunner } from './keychain-security.js'

/**
 * Test seam for the keychain transfer: overrides the production `security`
 * runner / storage lock factory. Module-global by necessity — the transfer
 * strategy is constructed by the inventory mechanism, which forwards no
 * harness-local options. Tests that set this must reset it in `afterEach`;
 * production never sets it.
 */
export const claudeKeychainSeams: {
  runner?: SecurityRunner
  lockFactory?: ClaudeStorageLockFactory
} = {}

/**
 * Project Claude's onboarding state down to the portable subset.
 *
 * Machine ids, project paths and the OAuth account must never cross machines —
 * only the onboarding markers travel. Throwing rejects the payload.
 */
export function sanitizedClaudeState(value: unknown): Record<string, boolean | string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Claude state is not an object')
  }
  const source = value as Record<string, unknown>
  if (source.hasCompletedOnboarding !== true) {
    throw new Error('Claude onboarding is not complete on the source machine')
  }
  const result: Record<string, boolean | string> = { hasCompletedOnboarding: true }
  if (
    typeof source.lastOnboardingVersion === 'string' &&
    source.lastOnboardingVersion.length <= 64
  ) {
    result.lastOnboardingVersion = source.lastOnboardingVersion
  }
  if (typeof source.installMethod === 'string' && source.installMethod.length <= 32) {
    result.installMethod = source.installMethod
  }
  return result
}

export const claudeCredentials: HarnessCredentials = {
  kinds: ['claude-code', 'claude-code-state'],
  files: [
    {
      kind: 'claude-code',
      dirName: '.claude',
      fileName: '.credentials.json',
      homeEnvVar: 'CLAUDE_CONFIG_DIR',
      propagatable: true,
      validate: hasValidClaudeCredential,
      freshness: readClaudeCredentialFreshness,
      compareFreshness: compareClaudeCredentialFreshness,
    },
    {
      kind: 'claude-code-state',
      dirName: '',
      fileName: '.claude.json',
      propagatable: false,
      mergeInstall: true,
      validate: () => true,
      freshness: () => undefined,
      compareFreshness: () => null,
      sanitize: sanitizedClaudeState,
    },
  ],
  identity: (read) => {
    const raw = read('', '.claude.json')
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } }
      const email =
        typeof parsed.oauthAccount?.emailAddress === 'string'
          ? parsed.oauthAccount.emailAddress.trim()
          : ''
      return email ? { fingerprint: fingerprintForLoginIdentity(email), email } : undefined
    } catch {
      return undefined
    }
  },
  transfer: supported({
    createStore: (ctx) => {
      if (ctx.platform !== 'darwin') return undefined
      if (ctx.file.kind !== 'claude-code') return undefined
      return new ClaudeKeychainCredentialStore({
        home: ctx.home,
        env: ctx.env,
        ...(ctx.osUsername !== undefined ? { osUsername: ctx.osUsername } : {}),
        ...(ctx.versions.get('claude-code') !== undefined
          ? { resolvedClaudeVersion: ctx.versions.get('claude-code') as string }
          : {}),
        ...(claudeKeychainSeams.runner !== undefined
          ? { runner: claudeKeychainSeams.runner }
          : {}),
        ...(claudeKeychainSeams.lockFactory !== undefined
          ? { lockFactory: claudeKeychainSeams.lockFactory }
          : {}),
      })
    },
  }),
}
