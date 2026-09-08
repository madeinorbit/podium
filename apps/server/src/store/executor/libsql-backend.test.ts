/**
 * Per-backend acceptance against local sqld [POD-3272].
 *
 * Hosted Turso is the same client over the network; this file is what CI can
 * run. skipIf there is no sqld binary.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createLibsqlClient } from '@podium/runtime/libsql'
import { SessionStore } from '../../store'
import { sqldBinary, startLocalSqld } from '../../test-support/sqld'
import { classifyLibsqlFailure, createLibsqlStoreExecutor } from './libsql-driver'
import { configureLibsqlConnection, runLibsqlMigrations } from '../../migrations/libsql'

const SQLD = sqldBinary()

describe.skipIf(SQLD === undefined)('libsql backend against sqld', () => {
  const servers: Array<{ dispose(): Promise<void> }> = []

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.dispose()
  })

  it('boots a fresh database, migrates, transacts, and shuts down with a parked body', async () => {
    const server = await startLocalSqld()
    servers.push(server)
    const client = createLibsqlClient({ url: server.config.url })
    await configureLibsqlConnection(client)
    const applied = await runLibsqlMigrations(client)
    expect(applied.length).toBeGreaterThan(0)

    const executor = createLibsqlStoreExecutor({ client, startOpen: true })
    try {
      await executor.transact(async (tx) => {
        await tx.drizzle.run(`INSERT INTO meta (key, value) VALUES (?, ?)`, 'turso.probe', 'ok')
        const row = (await tx.drizzle.get(`SELECT value FROM meta WHERE key = ?`, 'turso.probe')) as
          | { value: string }
          | undefined
        expect(row?.value).toBe('ok')
      })

      let parked: Promise<void> | undefined
      let releasePark: (() => void) | undefined
      const hold = new Promise<void>((resolve) => {
        releasePark = resolve
      })
      parked = executor.transact(async (tx) => {
        await tx.drizzle.run(`INSERT INTO meta (key, value) VALUES (?, ?)`, 'turso.park', '1')
        await hold
      })
      releasePark?.()
      await parked
      await executor.close()
    } finally {
      client.close()
    }
  })

  it('opens SessionStore on Turso from instance-config credentials', async () => {
    const server = await startLocalSqld()
    servers.push(server)
    const previousUrl = process.env.PODIUM_DATABASE_URL
    const previousToken = process.env.PODIUM_DATABASE_AUTH_TOKEN
    process.env.PODIUM_DATABASE_URL = server.config.url
    process.env.PODIUM_DATABASE_AUTH_TOKEN = 'unused-local'
    try {
      const store = await SessionStore.open()
      try {
        expect(store.durability.capabilities.backup).toBe('platform-managed')
        expect(store.durability.capabilities.candidateValidation).toBe('not-applicable')
        await expect(store.durability.checkpoint()).rejects.toThrow(/not applicable/)
      } finally {
        await store.close()
      }
    } finally {
      if (previousUrl === undefined) delete process.env.PODIUM_DATABASE_URL
      else process.env.PODIUM_DATABASE_URL = previousUrl
      if (previousToken === undefined) delete process.env.PODIUM_DATABASE_AUTH_TOKEN
      else process.env.PODIUM_DATABASE_AUTH_TOKEN = previousToken
    }
  })

  it('classifies a closed-transaction after a dropped connection as fatal', () => {
    const closed = Object.assign(new Error('Cannot execute statements because the transaction is closed'), {
      code: 'TRANSACTION_CLOSED',
    })
    expect(classifyLibsqlFailure(closed)).toBe('fatal')
  })
})
