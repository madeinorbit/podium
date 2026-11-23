/**
 * THE WORKSPACE STORE CONTEXT [POD-6959 design 2.4, task POD-7009].
 *
 * Every transaction carries a context (one workspace, or global); the join
 * rules hold between frames; a workspace handle's bound view fills
 * `workspaceId` and refuses work of another workspace; a driver reads the
 * context at `begin`. The table here is a fixture with a workspace column, so
 * the fill is observable before the real tables gain theirs (POD-7012).
 */

import { asWorkspaceId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { preparedDefinitions } from '@podium/sync/adapters/sqlite/prepared'
import { asc, eq, sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it } from 'vitest'
import { createBunSqliteDriver } from './bun-driver'
import {
  CrossWorkspaceTransactionError,
  currentStoreContext,
  WorkspaceTransactionInGlobalFrameError,
} from './context'
import type { DriverSession, StoreDriver } from './driver'
import { createStoreExecutor, GLOBAL_CONTEXT, type StoreContext } from './executor'
import {
  CallerWorkspaceValueError,
  CrossWorkspaceStatementError,
  executeRaw,
  fleetDb,
  inWorkspace,
  param,
  preparationsOf,
  prepared,
  preparedAcross,
  preparedFamily,
  preparedGlobal,
  WORKSPACE,
  WorkspaceStatementInGlobalTransactionError,
  workspaceQueries,
} from './sync-drizzle'

const notes = sqliteTable('ws_notes', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  body: text('body').notNull(),
})

const insertNote = prepared((db) =>
  db
    .insert(notes)
    .values({ workspaceId: WORKSPACE, id: sql.placeholder('id'), body: sql.placeholder('body') })
    .prepare(),
)
const noteById = prepared((db) =>
  db
    .select({ id: notes.id, body: notes.body })
    .from(notes)
    .where(inWorkspace(notes, eq(notes.id, param(notes.id, 'id'))))
    .prepare(),
)
const notesOf = preparedFamily((db, _t, order: 'id' | 'body') =>
  db
    .select({ id: notes.id })
    .from(notes)
    .where(inWorkspace(notes))
    .orderBy(asc(order === 'id' ? notes.id : notes.body))
    .prepare(),
)
const rawCount = prepared((db) =>
  db.get<{ n: number }>(sql`select count(*) as n from ws_notes where workspace_id = ${WORKSPACE}`),
)
const putMeta = preparedGlobal((db, t) =>
  db
    .insert(t.meta)
    .values({ key: sql.placeholder('key'), value: sql.placeholder('value') })
    .prepare(),
)
const allNotesAcross = preparedAcross(
  {
    file: 'apps/server/src/store/executor/workspace-context.test.ts',
    name: 'allNotesAcross',
    reason: 'fixture: a fleet read over every workspace',
    index: 'none (fixture)',
    issue: 'POD-7009',
  },
  (db) =>
    db
      .select({ workspaceId: notes.workspaceId, id: notes.id })
      .from(notes)
      .orderBy(asc(notes.workspaceId), asc(notes.id))
      .prepare(),
)

const A = asWorkspaceId('ws_a')
const B = asWorkspaceId('ws_b')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

/** An executor over an in-memory database; `begins` records the context each `begin` saw. */
function fixture() {
  const database = openDatabase(':memory:')
  database.exec(
    'CREATE TABLE ws_notes (workspace_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL); ' +
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  )
  const begins: (StoreContext | undefined)[] = []
  const bun = createBunSqliteDriver({ database })
  const driver: StoreDriver = {
    ...bun,
    async open(lane) {
      const session = await bun.open(lane)
      const observed: DriverSession = {
        execute: (statement) => session.execute(statement),
        executeBatch: (statements) => session.executeBatch(statements),
        begin: async (beginLane) => {
          begins.push(currentStoreContext())
          await session.begin(beginLane)
        },
        commit: () => session.commit(),
        rollback: () => session.rollback(),
        enterSavepoint: (name) => session.enterSavepoint(name),
        releaseSavepoint: (name) => session.releaseSavepoint(name),
        rollbackToSavepoint: (name) => session.rollbackToSavepoint(name),
        close: () => session.close(),
      }
      return observed
    },
  }
  const executor = createStoreExecutor({ driver })
  cleanup.push(async () => {
    await executor.close()
    database.close()
  })
  const root = executor.queries
  return {
    executor,
    root,
    a: workspaceQueries(root, A),
    b: workspaceQueries(root, B),
    begins,
    database,
  }
}

describe('a transaction carries its store context', () => {
  it('opens a workspace transaction with the workspace, visible to the body and to begin', async () => {
    const { executor, a, begins } = fixture()
    const seen = await a.createOrJoinTransaction(async () => currentStoreContext())
    expect(seen).toEqual({ kind: 'workspace', workspaceId: A })
    expect(begins).toEqual([{ kind: 'workspace', workspaceId: A }])
    expect(
      await executor.transact(async (tx) => tx.context, { kind: 'workspace', workspaceId: B }),
    ).toEqual({ kind: 'workspace', workspaceId: B })
  })

  it('opens a global transaction when the caller names no context', async () => {
    const { executor, begins } = fixture()
    expect(await executor.transact(async (tx) => [tx.context, currentStoreContext()])).toEqual([
      GLOBAL_CONTEXT,
      GLOBAL_CONTEXT,
    ])
    expect(begins).toEqual([GLOBAL_CONTEXT])
    expect(executor.context).toBe(GLOBAL_CONTEXT)
  })

  it('has no context at the root, and a savepoint has its parent’s', async () => {
    const { a } = fixture()
    expect(currentStoreContext()).toBeUndefined()
    const nested = await a.createOrJoinTransaction(
      async () => await a.createOrJoinTransaction(async () => currentStoreContext()),
    )
    expect(nested).toEqual({ kind: 'workspace', workspaceId: A })
  })
})

describe('the join rules', () => {
  it('refuses to join work of another workspace', async () => {
    const { a, b } = fixture()
    await expect(
      a.createOrJoinTransaction(async () => await b.createOrJoinTransaction(async () => 1)),
    ).rejects.toBeInstanceOf(CrossWorkspaceTransactionError)
  })

  it('lets a workspace frame run global work and global definitions', async () => {
    const { root, a, database } = fixture()
    await a.createOrJoinTransaction(async () => {
      await root.createOrJoinTransaction(async () => {
        await putMeta(a.db).run({ key: 'k', value: 'v' })
      })
      expect(currentStoreContext()).toEqual({ kind: 'workspace', workspaceId: A })
    })
    expect(database.prepare('select value from meta where key = ?').get('k')).toEqual({
      value: 'v',
    })
  })

  it('refuses workspace work and workspace statements inside a global frame', async () => {
    const { executor, a } = fixture()
    await expect(
      executor.transact(async () => await a.createOrJoinTransaction(async () => 1)),
    ).rejects.toBeInstanceOf(WorkspaceTransactionInGlobalFrameError)
    await expect(
      executor.transact(async () => await noteById(a.db).all({ id: 'n1' })),
    ).rejects.toBeInstanceOf(WorkspaceStatementInGlobalTransactionError)
  })

  it('refuses a statement of another workspace inside a workspace transaction', async () => {
    const { a, b } = fixture()
    await expect(
      a.createOrJoinTransaction(async () => await noteById(b.db).all({ id: 'n1' })),
    ).rejects.toBeInstanceOf(CrossWorkspaceStatementError)
  })
})

describe('the workspace fill', () => {
  it('fills workspaceId from the handle, so each workspace reads only its own rows', async () => {
    const { a, b, database } = fixture()
    await a.createOrJoinTransaction(async () => {
      await insertNote(a.db).run({ id: 'n1', body: 'from a' })
    })
    await insertNote(b.db).run({ id: 'n1', body: 'from b' })
    expect(await noteById(a.db).get({ id: 'n1' })).toEqual({ id: 'n1', body: 'from a' })
    expect(await noteById(b.db).all({ id: 'n1' })).toEqual([{ id: 'n1', body: 'from b' }])
    expect(await notesOf(a.db, 'id').all()).toEqual([{ id: 'n1' }])
    expect(await executeRaw(rawCount(b.db))).toEqual({ n: 1 })
    expect(database.prepare('select workspace_id, body from ws_notes order by 1').all()).toEqual([
      { workspace_id: 'ws_a', body: 'from a' },
      { workspace_id: 'ws_b', body: 'from b' },
    ])
  })

  it('refuses a caller value named workspaceId', async () => {
    const { a } = fixture()
    const values = { id: 'n1', workspaceId: B } as unknown as { id: string }
    expect(() => noteById(a.db).all(values)).toThrow(CallerWorkspaceValueError)
  })

  it('shares one prepared statement between workspaces and caches a view per handle', async () => {
    const { root, a, b } = fixture()
    const before = preparationsOf(root.rootDb)
    const viewA = noteById(a.db)
    expect(noteById(a.db)).toBe(viewA)
    expect(noteById(b.db)).not.toBe(viewA)
    expect(notesOf(a.db, 'body')).toBe(notesOf(a.db, 'body'))
    expect(preparationsOf(root.rootDb) - before).toBe(2)
  })

  it('leaves the bare drizzle instance unbound until the repositories take handles', async () => {
    const { root, a } = fixture()
    await insertNote(a.db).run({ id: 'n1', body: 'from a' })
    expect(await noteById(root.rootDb).all({ id: 'n1', workspaceId: A })).toEqual([
      { id: 'n1', body: 'from a' },
    ])
  })
})

describe('the definition kinds', () => {
  it('reads across workspaces on the fleet handle only', async () => {
    const { root, a, b } = fixture()
    await insertNote(a.db).run({ id: 'n1', body: 'a' })
    await insertNote(b.db).run({ id: 'n2', body: 'b' })
    expect(await allNotesAcross(fleetDb(root)).all()).toEqual([
      { workspaceId: 'ws_a', id: 'n1' },
      { workspaceId: 'ws_b', id: 'n2' },
    ])
    expect(() => allNotesAcross(a.db as never)).toThrow(TypeError)
    expect(() => noteById(root.db as never)).toThrow(TypeError)
  })

  it('records each definition’s kind, and a cross-workspace definition’s entry', () => {
    // The first frame past prepared.ts is the definition's own line: a module
    // this file imports may carry the import chain further down its stack.
    const mine = preparedDefinitions().filter((definition) =>
      (definition.site.stack ?? '')
        .split('\n')
        .slice(1)
        .find((frame) => !frame.includes('prepared.ts'))
        ?.includes('workspace-context.test.ts'),
    )
    expect(mine.map((definition) => [definition.kind, definition.scope])).toEqual([
      ['prepared', 'workspace'],
      ['prepared', 'workspace'],
      ['family', 'workspace'],
      ['prepared', 'workspace'],
      ['prepared', 'global'],
      ['prepared', 'across'],
    ])
    expect(mine.at(-1)?.entry?.name).toBe('allNotesAcross')
  })
})
