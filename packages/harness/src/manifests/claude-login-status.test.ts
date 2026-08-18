import { describe, expect, it } from 'vitest'
import { fingerprintForLoginIdentity } from '../codex-auth-identity.js'
import type { LoginCommandResult } from '../manifest.js'
import { classifyClaudeLoginStatus } from './claude-login-status.js'

function result(overrides: Partial<LoginCommandResult> = {}): LoginCommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  }
}

describe('classifyClaudeLoginStatus', () => {
  it('publishes logged-in email identity from a valid exit-0 document', () => {
    const email = 'person@example.com'
    expect(
      classifyClaudeLoginStatus(
        result({
          stdout: JSON.stringify({
            loggedIn: true,
            email: `  ${email}  `,
            orgName: 'Example Org',
            unknownFutureField: 'ignored',
          }),
        }),
      ),
    ).toEqual({
      kind: 'determined',
      login: {
        state: 'in',
        account: email,
        identity: { fingerprint: fingerprintForLoginIdentity(email), email },
      },
    })
  })

  it('uses orgName only as display text and never invents an identity', () => {
    expect(
      classifyClaudeLoginStatus(
        result({ stdout: JSON.stringify({ loggedIn: true, orgName: ' Example Org ' }) }),
      ),
    ).toEqual({
      kind: 'determined',
      login: { state: 'in', account: 'Example Org' },
    })
    expect(
      classifyClaudeLoginStatus(result({ stdout: JSON.stringify({ loggedIn: true }) })),
    ).toEqual({
      kind: 'determined',
      login: { state: 'in', account: 'Claude login' },
    })
  })

  it('accepts only valid logged-out JSON paired with documented exit 1', () => {
    expect(
      classifyClaudeLoginStatus(
        result({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 }),
      ),
    ).toEqual({ kind: 'determined', login: { state: 'out' } })
    expect(
      classifyClaudeLoginStatus(
        result({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 0 }),
      ).kind,
    ).toBe('unknown')
    expect(
      classifyClaudeLoginStatus(result({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 1 }))
        .kind,
    ).toBe('unknown')
  })

  it.each([
    '',
    'not json',
    'null',
    '[]',
    'true',
    '1',
    '{}',
    '{"loggedIn":"true"}',
    '{"loggedIn":true}\n{"loggedIn":false}',
  ])('rejects malformed or non-status output: %s', (stdout) => {
    expect(classifyClaudeLoginStatus(result({ stdout })).kind).toBe('unknown')
  })

  it.each([
    result({ timedOut: true }),
    result({ signal: 'SIGTERM' }),
    result({ errorCode: 'ENOENT', exitCode: null }),
    result({ errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', exitCode: null }),
    result({ exitCode: null }),
    result({ exitCode: 2 }),
    result({ stderr: 'Keychain access denied', exitCode: 1 }),
    result({
      stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.',
      exitCode: 1,
    }),
    result({ stderr: 'OAuth secure storage is locked', exitCode: 1 }),
  ])('classifies execution and Keychain failures as unknown', (commandResult) => {
    expect(classifyClaudeLoginStatus(commandResult).kind).toBe('unknown')
  })

  it('falls back only for the exact verified unsupported nested command response', () => {
    // Captured from official Claude Code 2.1.50 for an unrecognized nested auth
    // subcommand; status is the only spelling that denotes the compatibility gap.
    expect(
      classifyClaudeLoginStatus(
        result({
          stderr: "error: unknown command 'status'\n",
          exitCode: 1,
        }),
      ),
    ).toEqual({ kind: 'fallback' })

    for (const commandResult of [
      result({ stderr: 'Invalid API key · Please run /login', exitCode: 1 }),
      result({ stderr: 'Not logged in · Please run /login', exitCode: 1 }),
      result({ stderr: "error: unknown command 'auth'", exitCode: 1 }),
      result({ stderr: "error: unknown command 'status'", stdout: 'extra', exitCode: 1 }),
      result({ stderr: "error: unknown command 'status'", exitCode: 2 }),
    ]) {
      expect(classifyClaudeLoginStatus(commandResult).kind).toBe('unknown')
    }
  })
})
