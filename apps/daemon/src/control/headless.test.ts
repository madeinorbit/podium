import { createHash } from 'node:crypto'
import { asAccountId, asSessionId, asThreadId } from '@podium/model'
import { canonicalHeadlessTurnFacts } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { assertNativeHeadlessAccount, headlessTurnIdentityMatches } from './headless'

describe('tool-less headless account fence', () => {
  const inventory = (fingerprint: string) => ({
    agents: [
      {
        kind: 'claude-code' as const,
        installed: true,
        version: 'test',
        login: {
          state: 'in' as const,
          identity: { fingerprint, email: 'operator@example.test' },
        },
      },
    ],
  })

  it('refuses an ambient HOME or a login fingerprint swap immediately before launch', () => {
    const accountId = asAccountId('native:claude-code:first')
    expect(() =>
      assertNativeHeadlessAccount({
        agent: 'claude-code',
        accountId,
        accountHome: undefined,
        inventory: inventory('first'),
      }),
    ).toThrow(/separately provisioned account HOME/)
    expect(() =>
      assertNativeHeadlessAccount({
        agent: 'claude-code',
        accountId,
        accountHome: { path: '/isolated/account', source: 'test-override' },
        inventory: inventory('second'),
      }),
    ).toThrow(/fingerprint changed before launch/)
    expect(() =>
      assertNativeHeadlessAccount({
        agent: 'claude-code',
        accountId,
        accountHome: { path: '/isolated/account', source: 'configured' },
        inventory: inventory('first'),
      }),
    ).not.toThrow()
  })
})

describe('live headless identity fence', () => {
  it('refuses concurrent changed-spec and account collisions on one session/turn', () => {
    const digestFor = (prompt: string, accountId = asAccountId('native:claude-code:first')) =>
      createHash('sha256')
        .update(
          canonicalHeadlessTurnFacts({
            type: 'headlessTurnRequest',
            requestId: 'transport-only',
            requestDigest: '0'.repeat(64),
            turnId: 'turn:repair',
            sessionId: asSessionId('session:repair'),
            threadId: asThreadId('thread:repair'),
            accountId,
            agent: 'claude-code',
            cwd: '/repo',
            prompt,
          }),
        )
        .digest('hex')
    const established = {
      sessionId: asSessionId('session:repair'),
      turnId: 'turn:repair',
      requestDigest: digestFor('original prompt'),
      accountId: asAccountId('native:claude-code:first'),
    }
    expect(headlessTurnIdentityMatches(established, established)).toBe(true)
    expect(
      headlessTurnIdentityMatches(established, {
        ...established,
        requestDigest: digestFor('changed prompt'),
      }),
    ).toBe(false)
    expect(
      headlessTurnIdentityMatches(established, {
        ...established,
        accountId: asAccountId('native:claude-code:second'),
      }),
    ).toBe(false)
  })
})
