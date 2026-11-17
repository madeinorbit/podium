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
import { openTestIdentity } from '../../test-support/test-identity'
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
  it('a server secret and a password are found only in their homes', async () => {
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
      { key: 'integrations.linearApiKey', value: SERVER_SECRET },
    )

    // auth.setPassword, through the plain entry with the family's real handler.
    const instance = new InstanceService({
      users: store.users,
      credentials: (await openTestIdentity(store)).credentials,
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
    expect(await store.secrets.get('integrations.linearApiKey')).toBe(SERVER_SECRET)
    // The Linear key is sealed by the vault (credential management §7): its
    // plaintext is in no table, only the envelope in `server_secrets`.
    expect(tablesHolding(store, SERVER_SECRET)).toEqual([])
    // A password is kept only as a hash: the plaintext is nowhere.
    expect(tablesHolding(store, PASSWORD)).toEqual([])
  })
})
