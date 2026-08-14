import { asAccountId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { assertNativeHeadlessAccount } from './headless'

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
        homeDir: undefined,
        inventory: inventory('first'),
      }),
    ).toThrow(/isolated account HOME/)
    expect(() =>
      assertNativeHeadlessAccount({
        agent: 'claude-code',
        accountId,
        homeDir: '/isolated/account',
        inventory: inventory('second'),
      }),
    ).toThrow(/fingerprint changed before launch/)
  })
})
