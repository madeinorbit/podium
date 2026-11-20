import type { MachineId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import type { SQLiteSession } from 'drizzle-orm/sqlite-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzle as proxyDrizzle } from 'drizzle-orm/sqlite-proxy'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

interface Counts {
  constructions: number
  executions: number
}

interface MeasuredLoop {
  name: string
  targetSql: string
  executionRatio: number
  run(store: SessionStore, n: number): void | Promise<void>
  check?(store: SessionStore, n: number): void | Promise<void>
}

/**
 * Count at Drizzle's SQLiteSession.prepareQuery boundary, where a terminal
 * builder call constructs SQL. The returned prepared query is wrapped only to
 * establish the independent execution count; counting at the client would miss
 * the exact rebuild this gate exists to catch.
 *
 * The session is the store's root drizzle instance: since POD-7010 a repository
 * holds its workspace's query handle, which wraps that instance, instead of the
 * instance itself.
 */
const countPreparedQueryWork = (store: SessionStore, targetSql: string): Counts => {
  const counts: Counts = { constructions: 0, executions: 0 }
  const session = (store.database.queries.rootDb as unknown as { _: { session: SQLiteSession } })._
    .session
  const realPrepareQuery = session.prepareQuery.bind(session)
  session.prepareQuery = (...args: Parameters<SQLiteSession['prepareQuery']>) => {
    const prepared = realPrepareQuery(...args)
    if (!prepared.getQuery().sql.includes(targetSql)) return prepared
    counts.constructions++
    const realRun = prepared.run.bind(prepared)
    prepared.run = (placeholderValues) => {
      counts.executions++
      return realRun(placeholderValues)
    }
    return prepared
  }
  return counts
}

const conversationRows = (
  n: number,
  machineId: MachineId,
): Parameters<SessionStore['conversations']['index']['upsert']>[1] =>
  Array.from({ length: n }, (_, i) => ({
    id: `conversation-${i}`,
    agentKind: 'claude-code',
    providerId: 'claude-code-jsonl',
    machineId,
    title: `Conversation ${i}`,
    projectPath: '/repo',
    resumeKind: 'native',
    resumeValue: `resume-${i}`,
    createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    updatedAt: `2026-01-01T00:01:${String(i).padStart(2, '0')}Z`,
    messageCount: i + 2,
  }))

const loops: MeasuredLoop[] = [
  {
    name: 'ConversationIndexRepository.upsert',
    targetSql: 'insert into "conversations"',
    executionRatio: 1,
    run: async (store, n) =>
      await store.conversations.index.upsert(
        fixtureWriteScope(),
        conversationRows(n, store.hostMachine!.id),
      ),
    check: async (store, n) => {
      expect(await store.conversations.index.recentPage({ limit: n + 1 })).toHaveLength(n)
    },
  },
]

const measure = async (loop: MeasuredLoop, n: number): Promise<Counts> => {
  const store = await openTestStore(':memory:')
  try {
    const counts = countPreparedQueryWork(store, loop.targetSql)
    await loop.run(store, n)
    await loop.check?.(store, n)
    return counts
  } finally {
    await store.close()
  }
}

describe('prepared batch SQL construction', () => {
  it('builds a conversation upsert once and runs one statement per report', async () => {
    const loop = loops[0]!
    const small = await measure(loop, 4)
    const large = await measure(loop, 40)
    expect(small).toEqual({ constructions: 1, executions: 1 })
    expect(large).toEqual(small)
  })

  it('constructs each log chunk once and appends 100 rows per statement', async () => {
    const loop: MeasuredLoop = {
      name: 'SyncRepository.appendChanges',
      targetSql: 'insert into "changes"',
      executionRatio: 10,
      run: async (store, size) => {
        await store.sync.appendChanges(
          Array.from({ length: size }, (_, i) => ({
            entity: 'conversation',
            entityId: `c${i}`,
            op: 'upsert' as const,
            payload: '{}',
          })),
          1,
        )
      },
    }
    expect(await measure(loop, 100)).toEqual({ constructions: 1, executions: 1 })
    expect(await measure(loop, 1000)).toEqual({ constructions: 1, executions: 10 })
  })
})

const asyncPreparedProbe = sqliteTable('async_prepared_probe', {
  id: integer().primaryKey(),
  value: text().notNull(),
})

it('keeps a prepared query reusable when B1 makes each execution asynchronous', async () => {
  const calls: { sql: string; params: unknown[]; method: string }[] = []
  const db = proxyDrizzle(async (query, params, method) => {
    calls.push({ sql: query, params, method })
    return { rows: [] }
  })
  const prepared = db
    .insert(asyncPreparedProbe)
    .values({ id: sql.placeholder('id'), value: sql.placeholder('value') })
    .prepare()

  const first = prepared.run({ id: 1, value: 'one' })
  expect(first).toBeInstanceOf(Promise)
  await first
  await prepared.run({ id: 2, value: 'two' })

  expect(calls).toEqual([
    {
      sql: 'insert into "async_prepared_probe" ("id", "value") values (?, ?)',
      params: [1, 'one'],
      method: 'run',
    },
    {
      sql: 'insert into "async_prepared_probe" ("id", "value") values (?, ?)',
      params: [2, 'two'],
      method: 'run',
    },
  ])
})
