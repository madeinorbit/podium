import type { MachineId } from '@podium/model'
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
  repository(store: SessionStore): object
  run(store: SessionStore, n: number): void | Promise<void>
}

/**
 * Count at Drizzle's SQLiteSession.prepareQuery boundary, where a terminal
 * builder call constructs SQL. The returned prepared query is wrapped only to
 * establish the independent execution count; counting at the client would miss
 * the exact rebuild this gate exists to catch.
 */
const countPreparedQueryWork = (repository: object, targetSql: string): Counts => {
  const counts: Counts = { constructions: 0, executions: 0 }
  const session = (
    repository as {
      rootDb: { _: { session: SQLiteSession } }
    }
  ).rootDb._.session
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
): Parameters<SessionStore['conversations']['index']['upsert']>[0] =>
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
    repository: (store) => store.conversations.index,
    run: (store, n) => store.conversations.index.upsert(conversationRows(n, store.hostMachineId)),
  },
  {
    name: 'SyncRepository.applyLatestChangeStates',
    targetSql: 'insert into "change_latest"',
    repository: (store) => store.sync,
    run: (store, n) => {
      store.sync.appendChanges(
        Array.from({ length: n }, (_, i) => ({
          entity: 'issue',
          entityId: `issue-${i}`,
          op: 'upsert' as const,
          payload: '{}',
        })),
        1,
      )
    },
  },
]

const measure = async (loop: MeasuredLoop, n: number): Promise<Counts> => {
  const store = await openTestStore(':memory:')
  const counts = countPreparedQueryWork(loop.repository(store), loop.targetSql)
  await loop.run(store, n)
  return counts
}

describe('large row-loop SQL construction', () => {
  it.each(loops)('$name keeps constructions constant while executions scale 10x', async (loop) => {
    const n = 4
    const small = await measure(loop, n)
    const large = await measure(loop, n * 10)
    const executionRatio = large.executions / small.executions
    const constructionRatio = large.constructions / small.constructions

    expect(
      small.constructions,
      `${loop.name}: the SQLiteSession.prepareQuery probe saw no construction`,
    ).toBeGreaterThan(0)
    expect(executionRatio, `${loop.name}: executions must track the 10x larger input`).toBeCloseTo(
      10,
      5,
    )
    expect(
      constructionRatio,
      `${loop.name}: SQLiteSession.prepareQuery constructions scaled with row count`,
    ).toBeLessThanOrEqual(1)
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
