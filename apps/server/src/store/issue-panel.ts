import {
  IssuePanelArtifactWire,
  IssuePanelDeferredWire,
  type IssuePanelKind,
  IssuePanelStateWire,
  IssuePanelTodoWire,
} from '@podium/model'
import type { WriteScope } from '@podium/sync'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  issuePanelArtifacts,
  issuePanelDeferred,
  issuePanelStates,
  issuePanelTodos,
  issues,
} from '../migrations/schema'
import type { StoreDrizzle, StoreQueries } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  prepared,
  preparedFamily,
} from './executor/sync-drizzle'

export type PanelRecord =
  | IssuePanelTodoWire
  | IssuePanelArtifactWire
  | IssuePanelDeferredWire
  | IssuePanelStateWire

const todoByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ item: issuePanelTodos })
    .from(issuePanelTodos)
    .innerJoin(issues, eq(issues.id, issuePanelTodos.issueId))
    .where(and(inListOf(issuePanelTodos.id, size), isNull(issues.deletedAt)))
    .prepare(),
)
const todoOfIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(issuePanelTodos)
    .where(inListOf(issuePanelTodos.issueId, size))
    .orderBy(asc(issuePanelTodos.issueId), asc(issuePanelTodos.position), asc(issuePanelTodos.id))
    .prepare(),
)
const todoPage = preparedFamily((db: StoreDrizzle, phase: 'start' | 'after') =>
  db
    .select({ item: issuePanelTodos })
    .from(issuePanelTodos)
    .innerJoin(issues, eq(issues.id, issuePanelTodos.issueId))
    .where(
      and(
        isNull(issues.deletedAt),
        phase === 'after' ? gt(issuePanelTodos.id, param(issuePanelTodos.id, 'after')) : undefined,
      ),
    )
    .orderBy(asc(issuePanelTodos.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const todoNext = prepared((db: StoreDrizzle) =>
  db
    .select({ position: sql<number>`coalesce(max(${issuePanelTodos.position}), -1) + 1` })
    .from(issuePanelTodos)
    .where(eq(issuePanelTodos.issueId, param(issuePanelTodos.issueId, 'issueId')))
    .prepare(),
)
const todoRemove = prepared((db: StoreDrizzle) =>
  db
    .delete(issuePanelTodos)
    .where(
      and(
        eq(issuePanelTodos.id, param(issuePanelTodos.id, 'id')),
        eq(issuePanelTodos.issueId, param(issuePanelTodos.issueId, 'issueId')),
      ),
    )
    .prepare(),
)
const todoSave = prepared((db: StoreDrizzle) =>
  db
    .insert(issuePanelTodos)
    .values({
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      position: sql.placeholder('position'),
      text: sql.placeholder('text'),
      done: sql.placeholder('done'),
    })
    .onConflictDoUpdate({
      target: issuePanelTodos.id,
      set: { text: sql`excluded.text`, done: sql`excluded.done` },
    })
    .prepare(),
)

const artifactByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ item: issuePanelArtifacts })
    .from(issuePanelArtifacts)
    .innerJoin(issues, eq(issues.id, issuePanelArtifacts.issueId))
    .where(and(inListOf(issuePanelArtifacts.id, size), isNull(issues.deletedAt)))
    .prepare(),
)
const artifactOfIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(issuePanelArtifacts)
    .where(inListOf(issuePanelArtifacts.issueId, size))
    .orderBy(
      asc(issuePanelArtifacts.issueId),
      asc(issuePanelArtifacts.position),
      asc(issuePanelArtifacts.id),
    )
    .prepare(),
)
const artifactPage = preparedFamily((db: StoreDrizzle, phase: 'start' | 'after') =>
  db
    .select({ item: issuePanelArtifacts })
    .from(issuePanelArtifacts)
    .innerJoin(issues, eq(issues.id, issuePanelArtifacts.issueId))
    .where(
      and(
        isNull(issues.deletedAt),
        phase === 'after'
          ? gt(issuePanelArtifacts.id, param(issuePanelArtifacts.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(issuePanelArtifacts.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const artifactNext = prepared((db: StoreDrizzle) =>
  db
    .select({ position: sql<number>`coalesce(max(${issuePanelArtifacts.position}), -1) + 1` })
    .from(issuePanelArtifacts)
    .where(eq(issuePanelArtifacts.issueId, param(issuePanelArtifacts.issueId, 'issueId')))
    .prepare(),
)
const artifactRemove = prepared((db: StoreDrizzle) =>
  db
    .delete(issuePanelArtifacts)
    .where(
      and(
        eq(issuePanelArtifacts.id, param(issuePanelArtifacts.id, 'id')),
        eq(issuePanelArtifacts.issueId, param(issuePanelArtifacts.issueId, 'issueId')),
      ),
    )
    .prepare(),
)
const artifactSave = prepared((db: StoreDrizzle) =>
  db
    .insert(issuePanelArtifacts)
    .values({
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      position: sql.placeholder('position'),
      path: sql.placeholder('path'),
      value: sql.placeholder('value'),
    })
    .onConflictDoUpdate({
      target: issuePanelArtifacts.id,
      set: { path: sql`excluded.path`, value: sql`excluded.value` },
    })
    .prepare(),
)

const deferredByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ item: issuePanelDeferred })
    .from(issuePanelDeferred)
    .innerJoin(issues, eq(issues.id, issuePanelDeferred.issueId))
    .where(and(inListOf(issuePanelDeferred.id, size), isNull(issues.deletedAt)))
    .prepare(),
)
const deferredOfIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(issuePanelDeferred)
    .where(inListOf(issuePanelDeferred.issueId, size))
    .orderBy(
      asc(issuePanelDeferred.issueId),
      asc(issuePanelDeferred.position),
      asc(issuePanelDeferred.id),
    )
    .prepare(),
)
const deferredPage = preparedFamily((db: StoreDrizzle, phase: 'start' | 'after') =>
  db
    .select({ item: issuePanelDeferred })
    .from(issuePanelDeferred)
    .innerJoin(issues, eq(issues.id, issuePanelDeferred.issueId))
    .where(
      and(
        isNull(issues.deletedAt),
        phase === 'after'
          ? gt(issuePanelDeferred.id, param(issuePanelDeferred.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(issuePanelDeferred.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const deferredNext = prepared((db: StoreDrizzle) =>
  db
    .select({ position: sql<number>`coalesce(max(${issuePanelDeferred.position}), -1) + 1` })
    .from(issuePanelDeferred)
    .where(eq(issuePanelDeferred.issueId, param(issuePanelDeferred.issueId, 'issueId')))
    .prepare(),
)
const deferredRemove = prepared((db: StoreDrizzle) =>
  db
    .delete(issuePanelDeferred)
    .where(
      and(
        eq(issuePanelDeferred.id, param(issuePanelDeferred.id, 'id')),
        eq(issuePanelDeferred.issueId, param(issuePanelDeferred.issueId, 'issueId')),
      ),
    )
    .prepare(),
)
const deferredSave = prepared((db: StoreDrizzle) =>
  db
    .insert(issuePanelDeferred)
    .values({
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      position: sql.placeholder('position'),
      text: sql.placeholder('text'),
      addedAt: sql.placeholder('addedAt'),
    })
    .onConflictDoUpdate({
      target: issuePanelDeferred.id,
      set: { text: sql`excluded.text`, addedAt: sql`excluded.added_at` },
    })
    .prepare(),
)

const stateByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ item: issuePanelStates })
    .from(issuePanelStates)
    .innerJoin(issues, eq(issues.id, issuePanelStates.id))
    .where(and(inListOf(issuePanelStates.id, size), isNull(issues.deletedAt)))
    .prepare(),
)
const stateOfIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(issuePanelStates)
    .where(inListOf(issuePanelStates.id, size))
    .orderBy(asc(issuePanelStates.id))
    .prepare(),
)
const statePage = preparedFamily((db: StoreDrizzle, phase: 'start' | 'after') =>
  db
    .select({ item: issuePanelStates })
    .from(issuePanelStates)
    .innerJoin(issues, eq(issues.id, issuePanelStates.id))
    .where(
      and(
        isNull(issues.deletedAt),
        phase === 'after'
          ? gt(issuePanelStates.id, param(issuePanelStates.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(issuePanelStates.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const stateSave = prepared((db: StoreDrizzle) =>
  db
    .insert(issuePanelStates)
    .values({
      id: sql.placeholder('id'),
      text: sql.placeholder('text'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: issuePanelStates.id,
      set: { text: sql`excluded.text`, updatedAt: sql`excluded.updated_at` },
    })
    .prepare(),
)

const clearTodos = prepared((db: StoreDrizzle) =>
  db
    .delete(issuePanelTodos)
    .where(eq(issuePanelTodos.issueId, param(issuePanelTodos.issueId, 'issueId')))
    .returning({ id: issuePanelTodos.id })
    .prepare(),
)
const toggleTodo = prepared((db: StoreDrizzle) =>
  db
    .update(issuePanelTodos)
    .set({ done: sql.placeholder('done') })
    .where(
      and(
        eq(issuePanelTodos.id, param(issuePanelTodos.id, 'id')),
        eq(issuePanelTodos.issueId, param(issuePanelTodos.issueId, 'issueId')),
      ),
    )
    .returning()
    .prepare(),
)

const todoExists = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issuePanelTodos.id })
    .from(issuePanelTodos)
    .where(eq(issuePanelTodos.id, param(issuePanelTodos.id, 'id')))
    .prepare(),
)
const artifactExists = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issuePanelArtifacts.id })
    .from(issuePanelArtifacts)
    .where(eq(issuePanelArtifacts.id, param(issuePanelArtifacts.id, 'id')))
    .prepare(),
)
const deferredExists = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issuePanelDeferred.id })
    .from(issuePanelDeferred)
    .where(eq(issuePanelDeferred.id, param(issuePanelDeferred.id, 'id')))
    .prepare(),
)

/** Tables are the only home. Read grouping and ordering happen in SQL. */
export class IssuePanelRepository {
  private readonly db: StoreDrizzle
  constructor(queries: StoreQueries) {
    this.db = queries.rootDb
  }
  /** Identity collisions are checked even under a deleted parent. */
  async hasId(kind: Exclude<IssuePanelKind, 'issuePanelState'>, id: string): Promise<boolean> {
    const query =
      kind === 'issuePanelTodo'
        ? todoExists
        : kind === 'issuePanelArtifact'
          ? artifactExists
          : deferredExists
    return (await query(this.db).get({ id })) !== undefined
  }
  async getMany(kind: IssuePanelKind, ids: readonly string[]): Promise<PanelRecord[]> {
    if (!ids.length) return []
    const size = inListSize(ids.length),
      values = inListValues(ids, size)
    switch (kind) {
      case 'issuePanelTodo':
        return (await todoByIds(this.db, size).all(values)).map((r) =>
          IssuePanelTodoWire.parse(r.item),
        )
      case 'issuePanelArtifact':
        return (await artifactByIds(this.db, size).all(values)).map((r) =>
          IssuePanelArtifactWire.parse({
            ...JSON.parse(r.item.value),
            id: r.item.id,
            issueId: r.item.issueId,
            position: r.item.position,
          }),
        )
      case 'issuePanelDeferred':
        return (await deferredByIds(this.db, size).all(values)).map((r) =>
          IssuePanelDeferredWire.parse(r.item),
        )
      case 'issuePanelState':
        return (await stateByIds(this.db, size).all(values)).map((r) =>
          IssuePanelStateWire.parse(r.item),
        )
    }
  }
  async forIssues(kind: IssuePanelKind, ids: readonly string[]): Promise<PanelRecord[]> {
    if (!ids.length) return []
    const size = inListSize(ids.length),
      values = inListValues(ids, size)
    switch (kind) {
      case 'issuePanelTodo':
        return (await todoOfIssues(this.db, size).all(values)).map((r) =>
          IssuePanelTodoWire.parse(r),
        )
      case 'issuePanelArtifact':
        return (await artifactOfIssues(this.db, size).all(values)).map((r) =>
          IssuePanelArtifactWire.parse({
            ...JSON.parse(r.value),
            id: r.id,
            issueId: r.issueId,
            position: r.position,
          }),
        )
      case 'issuePanelDeferred':
        return (await deferredOfIssues(this.db, size).all(values)).map((r) =>
          IssuePanelDeferredWire.parse(r),
        )
      case 'issuePanelState':
        return (await stateOfIssues(this.db, size).all(values)).map((r) =>
          IssuePanelStateWire.parse(r),
        )
    }
  }
  async readMany(ids: readonly string[]) {
    const todos = (await this.forIssues('issuePanelTodo', ids)) as IssuePanelTodoWire[]
    const artifacts = (await this.forIssues('issuePanelArtifact', ids)) as IssuePanelArtifactWire[]
    const deferred = (await this.forIssues('issuePanelDeferred', ids)) as IssuePanelDeferredWire[]
    const states = (await this.forIssues('issuePanelState', ids)) as IssuePanelStateWire[]
    const out = new Map(
      ids.map((id) => [
        id,
        {
          panel: {
            todos: [] as IssuePanelTodoWire[],
            artifacts: [] as IssuePanelArtifactWire[],
            deferred: [] as IssuePanelDeferredWire[],
          },
          state: undefined as IssuePanelStateWire | undefined,
        },
      ]),
    )
    for (const row of todos) out.get(row.issueId)?.panel.todos.push(row)
    for (const row of artifacts) out.get(row.issueId)?.panel.artifacts.push(row)
    for (const row of deferred) out.get(row.issueId)?.panel.deferred.push(row)
    for (const row of states) {
      const target = out.get(row.id)
      if (target) target.state = row
    }
    return out
  }
  async read(id: string) {
    return (await this.readMany([id])).get(id)!.panel
  }
  async state(id: string): Promise<IssuePanelStateWire | undefined> {
    return (await this.getMany('issuePanelState', [id]))[0] as IssuePanelStateWire | undefined
  }
  async next(kind: Exclude<IssuePanelKind, 'issuePanelState'>, issueId: string): Promise<number> {
    const statement =
      kind === 'issuePanelTodo'
        ? todoNext
        : kind === 'issuePanelArtifact'
          ? artifactNext
          : deferredNext
    return (await statement(this.db).get({ issueId }))!.position
  }
  async save(_scope: WriteScope, kind: IssuePanelKind, record: PanelRecord): Promise<void> {
    switch (kind) {
      case 'issuePanelTodo':
        await todoSave(this.db).run(record)
        break
      case 'issuePanelArtifact': {
        const r = record as IssuePanelArtifactWire
        const { id, issueId, position, ...value } = r
        await artifactSave(this.db).run({
          id,
          issueId,
          position,
          path: r.path,
          value: JSON.stringify(value),
        })
        break
      }
      case 'issuePanelDeferred':
        await deferredSave(this.db).run(record)
        break
      case 'issuePanelState':
        await stateSave(this.db).run(record)
        break
    }
  }
  async remove(
    _scope: WriteScope,
    kind: Exclude<IssuePanelKind, 'issuePanelState'>,
    issueId: string,
    id: string,
  ): Promise<void> {
    const statement =
      kind === 'issuePanelTodo'
        ? todoRemove
        : kind === 'issuePanelArtifact'
          ? artifactRemove
          : deferredRemove
    await statement(this.db).run({ issueId, id })
  }
  async clearTodos(_scope: WriteScope, issueId: string): Promise<string[]> {
    return (await clearTodos(this.db).all({ issueId })).map((r) => r.id)
  }
  async toggle(
    _scope: WriteScope,
    issueId: string,
    id: string,
    done: boolean,
  ): Promise<IssuePanelTodoWire | undefined> {
    return (await toggleTodo(this.db).get({ issueId, id, done })) as IssuePanelTodoWire | undefined
  }
  async *pages(kind: IssuePanelKind, pageSize = 500): AsyncGenerator<PanelRecord[]> {
    let after: string | undefined
    for (;;) {
      const values = { after: after ?? '', limit: pageSize }
      let rows: PanelRecord[]
      switch (kind) {
        case 'issuePanelTodo':
          rows = (await todoPage(this.db, after === undefined ? 'start' : 'after').all(values)).map(
            (r) => IssuePanelTodoWire.parse(r.item),
          )
          break
        case 'issuePanelArtifact':
          rows = (
            await artifactPage(this.db, after === undefined ? 'start' : 'after').all(values)
          ).map((r) =>
            IssuePanelArtifactWire.parse({
              ...JSON.parse(r.item.value),
              id: r.item.id,
              issueId: r.item.issueId,
              position: r.item.position,
            }),
          )
          break
        case 'issuePanelDeferred':
          rows = (
            await deferredPage(this.db, after === undefined ? 'start' : 'after').all(values)
          ).map((r) => IssuePanelDeferredWire.parse(r.item))
          break
        case 'issuePanelState':
          rows = (
            await statePage(this.db, after === undefined ? 'start' : 'after').all(values)
          ).map((r) => IssuePanelStateWire.parse(r.item))
          break
      }
      if (rows.length) yield rows
      if (rows.length < pageSize) return
      after = rows[rows.length - 1]!.id
    }
  }
}
