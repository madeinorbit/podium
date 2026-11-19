/**
 * Where the server's store is, and which engine that names [POD-6994]. Database-free.
 * The server started on a Postgres URL is `server.postgres.bun.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { DATABASE_URL_ENV, storeLocation, storeMigratesAtBoot } from './store'

describe('storeLocation', () => {
  it('names the state directory’s file unless the environment names a Postgres URL', () => {
    expect(storeLocation({}, {})).toMatch(/podium\.db$/)
    expect(storeLocation({ [DATABASE_URL_ENV]: 'postgres://u@h/db' }, {})).toBe('postgres://u@h/db')
    expect(() => storeLocation({ [DATABASE_URL_ENV]: '/var/podium.db' }, {})).toThrow(
      /must be a postgres/,
    )
  })

  it('refuses a config.json key that names the database, without echoing its value', () => {
    let message = ''
    try {
      storeLocation({}, { databaseUrl: 'postgres://user:secret@h/db' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/PODIUM_DATABASE_URL environment variable only/)
    expect(message).not.toContain('secret')
  })

  it('migrates a Postgres store at boot only when asked', () => {
    expect(storeMigratesAtBoot({})).toBe(false)
    expect(storeMigratesAtBoot({ PODIUM_DATABASE_MIGRATE_AT_BOOT: '1' })).toBe(true)
  })
})
