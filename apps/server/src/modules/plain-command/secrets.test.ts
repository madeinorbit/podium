/**
 * A SECRET NEVER APPEARS IN ANY STORED RESULT (ADR 12 D8, POD-6360).
 *
 * The plain path stores no result: it has no dedup ledger, because a result may
 * hold a secret. This proves it end to end, over a real store, with the real
 * handlers of the three commands that carry credential material — a server
 * secret, a connected account's credential, a login password — and then reads
 * EVERY table back. The material may sit only in its declared home, and nowhere
 * else: not the mutation ledger, not the change log, not the settings trail.
 */

import { asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { ACCOUNT_COMMANDS_TRPC } from '../accounts/registry'
import { EventBus } from '../bus'
import { AUTH_COMMANDS_TRPC } from '../instance/registry'
import { InstanceService } from '../instance/service'
import { SettingsService } from '../settings/service'
import { plainSettingsCommandWith } from '../settings/trpc'
import { runPlainCommand } from './entry'

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const SERVER_SECRET = 'sk-plain-path-server-secret-6360'
const ACCOUNT_CREDENTIAL = 'sk-ant-plain-path-account-credential-6360'
const PASSWORD = 'plain-path-password-6360'

/** Every table whose rows mention `needle`, read raw. */
function tablesHolding(store: SessionStore, needle: string): string[] {
  // @ts-expect-error reach the private db for a whole-database read
  const db = store.db as {
    prepare(sql: string): { all(): unknown[] }
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]
  expect(tables.length).toBeGreaterThan(20)
  return tables
    .filter(({ name }) =>
      db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .some((row) => JSON.stringify(row).includes(needle)),
    )
    .map(({ name }) => name)
}

describe('the plain path stores no result', () => {
  it('server secret, account credential and password are found only in their homes', async () => {
    const store = await openTestStore(':memory:')
    opened.push(store)
    const adminId = firstAdminMemberId()
    const admin: CommandPrincipal = userCommandPrincipal(adminId, 'admin')

    // settings.setSecret, through the settings family's plain arm: gate, handler
    // and trail, over the real settings and secret stores.
    const settings = new SettingsService(store.settings, store.secrets, new EventBus(), {
      telegramBindings: store.telegramBindings,
      audit: { repo: store.settingsAudit, now: () => '2026-11-04T00:00:00.000Z' },
      now: () => Date.parse('2026-11-04T00:00:00.000Z'),
    })
    await plainSettingsCommandWith(
      'settings.setSecret',
      admin,
      async () => ({ deps: { principal: admin, role: 'admin' }, service: settings }),
      { key: 'apiKeys.anthropic', value: SERVER_SECRET },
    )

    // accounts.connect, through the plain entry with the family's real handler.
    const connected = await runPlainCommand({
      contract: ACCOUNT_COMMANDS_TRPC.connect.contract,
      principal: admin,
      transport: 'trpc',
      input: { provider: 'anthropic', kind: 'api-key', credential: ACCOUNT_CREDENTIAL },
      run: async (input) =>
        await ACCOUNT_COMMANDS_TRPC.connect.handler(
          { accounts: store.accounts } as never,
          input as never,
        ),
    })
    expect(connected.outcome).toBe('applied')

    // auth.setPassword, through the plain entry with the family's real handler.
    const instance = new InstanceService({
      users: store.users,
      callerUserId: asUserId(adminId),
      loginRequired: async () => true,
    } as never)
    const password = await runPlainCommand({
      contract: AUTH_COMMANDS_TRPC.setPassword.contract,
      principal: admin,
      transport: 'trpc',
      input: { next: PASSWORD },
      run: async (input) => await AUTH_COMMANDS_TRPC.setPassword.handler(instance, input as never),
    })
    expect(password.outcome).toBe('applied')

    // The positive control: each write landed, so a miss below is not a no-op.
    expect(await store.secrets.get('apiKeys.anthropic')).toBe(SERVER_SECRET)
    expect(tablesHolding(store, ACCOUNT_CREDENTIAL)).toEqual(['accounts'])
    expect(tablesHolding(store, SERVER_SECRET)).toEqual(['server_secrets'])
    // A password is kept only as a hash: the plaintext is nowhere.
    expect(tablesHolding(store, PASSWORD)).toEqual([])
  })
})
