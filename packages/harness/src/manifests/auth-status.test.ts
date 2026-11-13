/**
 * The harnesses' own answers to "which login are you on" (credential
 * management §9 "Launching"), classified from the shapes measured on Claude
 * Code 2.1.323 and Codex 0.167.2. Identities are obviously fake.
 */

import { describe, expect, it } from 'vitest'
import { fingerprintForLoginIdentity } from '../adapters/shared/login-identity.js'
import { manifestFor } from '../registry.js'
import { classifyClaudeAuthStatus } from './claude-auth-status.js'
import { classifyCodexLoginStatus } from './codex-login-status.js'

const ran = (stdout: string, exitCode: number | null = 0, stderr = '') => ({
  stdout,
  stderr,
  exitCode,
  timedOut: false,
})

describe('classifyClaudeAuthStatus', () => {
  it('a subscription login names its account and its fingerprint', () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'someone@example.invalid',
      subscriptionType: 'max',
    })
    expect(classifyClaudeAuthStatus(ran(out))).toEqual({
      method: 'subscription',
      email: 'someone@example.invalid',
      fingerprint: fingerprintForLoginIdentity('someone@example.invalid'),
    })
  })

  it('a key names the variable it came from', () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      apiKeySource: 'ANTHROPIC_API_KEY',
    })
    expect(classifyClaudeAuthStatus(ran(out))).toEqual({
      method: 'api-key',
      sourceVariable: 'ANTHROPIC_API_KEY',
    })
  })

  it('a key from somewhere that is not a variable names no variable', () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiKeySource: 'apiKeyHelper',
    })
    expect(classifyClaudeAuthStatus(ran(out))).toEqual({ method: 'api-key' })
  })

  it('a long-lived token is a token from its variable', () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' })
    expect(classifyClaudeAuthStatus(ran(out))).toEqual({
      method: 'token',
      sourceVariable: 'CLAUDE_CODE_OAUTH_TOKEN',
    })
  })

  it('logged out, a failure, a timeout or noise is unknown', () => {
    expect(classifyClaudeAuthStatus(ran(JSON.stringify({ loggedIn: false }), 1))).toEqual({
      method: 'unknown',
    })
    expect(classifyClaudeAuthStatus(ran('not json'))).toEqual({ method: 'unknown' })
    expect(
      classifyClaudeAuthStatus({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
    ).toEqual({ method: 'unknown' })
    expect(
      classifyClaudeAuthStatus(ran(JSON.stringify({ loggedIn: true, authMethod: 'bedrock' }))),
    ).toEqual({ method: 'unknown' })
  })
})

describe('classifyCodexLoginStatus', () => {
  it('reads the three measured lines', () => {
    expect(classifyCodexLoginStatus(ran('Logged in using ChatGPT\n'))).toEqual({
      method: 'subscription',
    })
    expect(
      classifyCodexLoginStatus(ran('', 0, 'Logged in using an API key - sk-proj-***FAKE\n')),
    ).toEqual({ method: 'api-key' })
    expect(classifyCodexLoginStatus(ran('', 1, 'Not logged in\n'))).toEqual({ method: 'unknown' })
  })
})

describe('the declarations', () => {
  it('Claude Code and Codex declare their status commands', () => {
    expect(manifestFor('claude-code')?.inventory.authStatusProbe?.args).toEqual(['auth', 'status'])
    expect(manifestFor('codex')?.inventory.authStatusProbe?.args).toEqual(['login', 'status'])
  })
})
