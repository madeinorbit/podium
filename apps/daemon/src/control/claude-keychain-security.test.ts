import { describe, expect, it } from 'vitest'
import { claudeKeychainWriteInput, SECURITY_PATH } from './claude-keychain-security'

describe('macOS security process input', () => {
  it('pins the absolute executable path', () => {
    expect(SECURITY_PATH).toBe('/usr/bin/security')
  })

  it('puts hex credential bytes only on stdin and never widens ACL access', () => {
    const input = claudeKeychainWriteInput(
      'native-user',
      'Claude Code-credentials-21493821',
      Buffer.from('synthetic-secret'),
      true,
    )
    try {
      const command = input.toString('ascii')
      expect(command).toBe(
        'add-generic-password -U -a "native-user" -s "Claude Code-credentials-21493821" -X "73796e7468657469632d736563726574"\n',
      )
      expect(command).not.toContain('synthetic-secret')
      expect(command).not.toMatch(/(?:^|\s)-A(?:\s|$)/)
      expect(command).not.toContain('unlock-keychain')
    } finally {
      input.fill(0)
    }
  })

  it('omits update mode for the lockless create-only fallback', () => {
    const input = claudeKeychainWriteInput(
      'native-user',
      'Claude Code-credentials',
      Buffer.from('{}'),
      false,
    )
    try {
      expect(input.toString('ascii')).toBe(
        'add-generic-password -a "native-user" -s "Claude Code-credentials" -X "7b7d"\n',
      )
    } finally {
      input.fill(0)
    }
  })
})
