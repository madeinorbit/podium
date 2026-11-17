// workspace-scoped (POD-6959)
import {
  IssuePanelArtifactWire,
  IssuePanelDeferredWire,
  type IssuePanelKind,
  IssuePanelStateWire,
  IssuePanelTodoWire,
} from '@podium/model'
import type { WriteScope } from '@podium/sync'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { captureWrite } from '../sync/capture-pg'
import type { WorkspaceDb, WorkspaceQueries } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from './executor/sync-drizzle'

export type PanelRecord =
  | IssuePanelTodoWire
  | IssuePanelArtifactWire
  | IssuePanelDeferredWire
  | IssuePanelStateWire

const todoByIds = preparedFamily((db, t, size: number) =>
  db
    .select({ item: t.issuePanelTodos })
    .from(t.issuePanelTodos)
    .innerJoin(
      t.issues,
      and(sameWorkspace(t.issues, t.issuePanelTodos), eq(t.issues.id, t.issuePanelTodos.issueId)),
    )
    .where(
      inWorkspace(
        t.issuePanelTodos,
        inListOf(t.issuePanelTodos.id, size),
        isNull(t.issues.deletedAt),
      ),
    )
    .prepare(),
)
const todoOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.issuePanelTodos)
    .where(inWorkspace(t.issuePanelTodos, inListOf(t.issuePanelTodos.issueId, size)))
    .orderBy(
      asc(t.issuePanelTodos.issueId),
      asc(t.issuePanelTodos.position),
      asc(t.issuePanelTodos.id),
    )
    .prepare(),
)
const todoPage = preparedFamily((db, t, phase: 'start' | 'after') =>
  db
    .select({ item: t.issuePanelTodos })
    .from(t.issuePanelTodos)
    .innerJoin(
      t.issues,
      and(sameWorkspace(t.issues, t.issuePanelTodos), eq(t.issues.id, t.issuePanelTodos.issueId)),
    )
    .where(
      inWorkspace(
        t.issuePanelTodos,
        isNull(t.issues.deletedAt),
        phase === 'after'
          ? gt(t.issuePanelTodos.id, param(t.issuePanelTodos.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(t.issuePanelTodos.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const todoNext = prepared((db, t) =>
  db
    .select({ position: sql<number>`coalesce(max(${t.issuePanelTodos.position}), -1) + 1` })
    .from(t.issuePanelTodos)
    .where(
      inWorkspace(
        t.issuePanelTodos,
        eq(t.issuePanelTodos.issueId, param(t.issuePanelTodos.issueId, 'issueId')),
      ),
    )
    .prepare(),
)
const todoRemove = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issuePanelTodos)
      .where(
        inWorkspace(
          t.issuePanelTodos,
          eq(t.issuePanelTodos.id, param(t.issuePanelTodos.id, 'id')),
          eq(t.issuePanelTodos.issueId, param(t.issuePanelTodos.issueId, 'issueId')),
        ),
      ),
  ).prepare(),
)
const todoSave = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issuePanelTodos)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        issueId: sql.placeholder('issueId'),
        position: sql.placeholder('position'),
        text: sql.placeholder('text'),
        done: sql.placeholder('done'),
      })
      .onConflictDoUpdate({
        target: t.issuePanelTodos.id,
        set: { text: sql`excluded.text`, done: sql`excluded.done` },
      }),
  ).prepare(),
)

const artifactByIds = preparedFamily((db, t, size: number) =>
  db
    .select({ item: t.issuePanelArtifacts })
    .from(t.issuePanelArtifacts)
    .innerJoin(
      t.issues,
      and(
        sameWorkspace(t.issues, t.issuePanelArtifacts),
        eq(t.issues.id, t.issuePanelArtifacts.issueId),
      ),
    )
    .where(
      inWorkspace(
        t.issuePanelArtifacts,
        inListOf(t.issuePanelArtifacts.id, size),
        isNull(t.issues.deletedAt),
      ),
    )
    .prepare(),
)
const artifactOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.issuePanelArtifacts)
    .where(inWorkspace(t.issuePanelArtifacts, inListOf(t.issuePanelArtifacts.issueId, size)))
    .orderBy(
      asc(t.issuePanelArtifacts.issueId),
      asc(t.issuePanelArtifacts.position),
      asc(t.issuePanelArtifacts.id),
    )
    .prepare(),
)
const artifactPage = preparedFamily((db, t, phase: 'start' | 'after') =>
  db
    .select({ item: t.issuePanelArtifacts })
    .from(t.issuePanelArtifacts)
    .innerJoin(
      t.issues,
      and(
        sameWorkspace(t.issues, t.issuePanelArtifacts),
        eq(t.issues.id, t.issuePanelArtifacts.issueId),
      ),
    )
    .where(
      inWorkspace(
        t.issuePanelArtifacts,
        isNull(t.issues.deletedAt),
        phase === 'after'
          ? gt(t.issuePanelArtifacts.id, param(t.issuePanelArtifacts.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(t.issuePanelArtifacts.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const artifactNext = prepared((db, t) =>
  db
    .select({ position: sql<number>`coalesce(max(${t.issuePanelArtifacts.position}), -1) + 1` })
    .from(t.issuePanelArtifacts)
    .where(
      inWorkspace(
        t.issuePanelArtifacts,
        eq(t.issuePanelArtifacts.issueId, param(t.issuePanelArtifacts.issueId, 'issueId')),
      ),
    )
    .prepare(),
)
const artifactRemove = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issuePanelArtifacts)
      .where(
        inWorkspace(
          t.issuePanelArtifacts,
          eq(t.issuePanelArtifacts.id, param(t.issuePanelArtifacts.id, 'id')),
          eq(t.issuePanelArtifacts.issueId, param(t.issuePanelArtifacts.issueId, 'issueId')),
        ),
      ),
  ).prepare(),
)
const artifactSave = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issuePanelArtifacts)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        issueId: sql.placeholder('issueId'),
        position: sql.placeholder('position'),
        path: sql.placeholder('path'),
        value: sql.placeholder('value'),
      })
      .onConflictDoUpdate({
        target: t.issuePanelArtifacts.id,
        set: { path: sql`excluded.path`, value: sql`excluded.value` },
      }),
  ).prepare(),
)

const deferredByIds = preparedFamily((db, t, size: number) =>
  db
    .select({ item: t.issuePanelDeferred })
    .from(t.issuePanelDeferred)
    .innerJoin(
      t.issues,
      and(
        sameWorkspace(t.issues, t.issuePanelDeferred),
        eq(t.issues.id, t.issuePanelDeferred.issueId),
      ),
    )
    .where(
      inWorkspace(
        t.issuePanelDeferred,
        inListOf(t.issuePanelDeferred.id, size),
        isNull(t.issues.deletedAt),
      ),
    )
    .prepare(),
)
const deferredOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.issuePanelDeferred)
    .where(inWorkspace(t.issuePanelDeferred, inListOf(t.issuePanelDeferred.issueId, size)))
    .orderBy(
      asc(t.issuePanelDeferred.issueId),
      asc(t.issuePanelDeferred.position),
      asc(t.issuePanelDeferred.id),
    )
    .prepare(),
)
const deferredPage = preparedFamily((db, t, phase: 'start' | 'after') =>
  db
    .select({ item: t.issuePanelDeferred })
    .from(t.issuePanelDeferred)
    .innerJoin(
      t.issues,
      and(
        sameWorkspace(t.issues, t.issuePanelDeferred),
        eq(t.issues.id, t.issuePanelDeferred.issueId),
      ),
    )
    .where(
      inWorkspace(
        t.issuePanelDeferred,
        isNull(t.issues.deletedAt),
        phase === 'after'
          ? gt(t.issuePanelDeferred.id, param(t.issuePanelDeferred.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(t.issuePanelDeferred.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const deferredNext = prepared((db, t) =>
  db
    .select({ position: sql<number>`coalesce(max(${t.issuePanelDeferred.position}), -1) + 1` })
    .from(t.issuePanelDeferred)
    .where(
      inWorkspace(
        t.issuePanelDeferred,
        eq(t.issuePanelDeferred.issueId, param(t.issuePanelDeferred.issueId, 'issueId')),
      ),
    )
    .prepare(),
)
const deferredRemove = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issuePanelDeferred)
      .where(
        inWorkspace(
          t.issuePanelDeferred,
          eq(t.issuePanelDeferred.id, param(t.issuePanelDeferred.id, 'id')),
          eq(t.issuePanelDeferred.issueId, param(t.issuePanelDeferred.issueId, 'issueId')),
        ),
      ),
  ).prepare(),
)
const deferredSave = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issuePanelDeferred)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        issueId: sql.placeholder('issueId'),
        position: sql.placeholder('position'),
        text: sql.placeholder('text'),
        addedAt: sql.placeholder('addedAt'),
      })
      .onConflictDoUpdate({
        target: t.issuePanelDeferred.id,
        set: { text: sql`excluded.text`, addedAt: sql`excluded.added_at` },
      }),
  ).prepare(),
)

const stateByIds = preparedFamily((db, t, size: number) =>
  db
    .select({ item: t.issuePanelStates })
    .from(t.issuePanelStates)
    .innerJoin(
      t.issues,
      and(sameWorkspace(t.issues, t.issuePanelStates), eq(t.issues.id, t.issuePanelStates.id)),
    )
    .where(
      inWorkspace(
        t.issuePanelStates,
        inListOf(t.issuePanelStates.id, size),
        isNull(t.issues.deletedAt),
      ),
    )
    .prepare(),
)
const stateOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.issuePanelStates)
    .where(inWorkspace(t.issuePanelStates, inListOf(t.issuePanelStates.id, size)))
    .orderBy(asc(t.issuePanelStates.id))
    .prepare(),
)
const statePage = preparedFamily((db, t, phase: 'start' | 'after') =>
  db
    .select({ item: t.issuePanelStates })
    .from(t.issuePanelStates)
    .innerJoin(
      t.issues,
      and(sameWorkspace(t.issues, t.issuePanelStates), eq(t.issues.id, t.issuePanelStates.id)),
    )
    .where(
      inWorkspace(
        t.issuePanelStates,
        isNull(t.issues.deletedAt),
        phase === 'after'
          ? gt(t.issuePanelStates.id, param(t.issuePanelStates.id, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(t.issuePanelStates.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
const stateSave = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issuePanelStates)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        text: sql.placeholder('text'),
        updatedAt: sql.placeholder('updatedAt'),
      })
      .onConflictDoUpdate({
        target: t.issuePanelStates.id,
        set: { text: sql`excluded.text`, updatedAt: sql`excluded.updated_at` },
      }),
  ).prepare(),
)

const clearTodos = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issuePanelTodos)
      .where(
        inWorkspace(
          t.issuePanelTodos,
          eq(t.issuePanelTodos.issueId, param(t.issuePanelTodos.issueId, 'issueId')),
        ),
      )
      .returning({ id: t.issuePanelTodos.id }),
  ).prepare(),
)
const toggleTodo = prepared((db, t) =>
  captureWrite(
    db
      .update(t.issuePanelTodos)
      .set({ done: sql.placeholder('done') })
      .where(
        inWorkspace(
          t.issuePanelTodos,
          eq(t.issuePanelTodos.id, param(t.issuePanelTodos.id, 'id')),
          eq(t.issuePanelTodos.issueId, param(t.issuePanelTodos.issueId, 'issueId')),
        ),
      )
      .returning(),
  ).prepare(),
)

const todoExists = prepared((db, t) =>
  db
    .select({ id: t.issuePanelTodos.id })
    .from(t.issuePanelTodos)
    .where(
      inWorkspace(t.issuePanelTodos, eq(t.issuePanelTodos.id, param(t.issuePanelTodos.id, 'id'))),
    )
    .prepare(),
)
const artifactExists = prepared((db, t) =>
  db
    .select({ id: t.issuePanelArtifacts.id })
    .from(t.issuePanelArtifacts)
    .where(
      inWorkspace(
        t.issuePanelArtifacts,
        eq(t.issuePanelArtifacts.id, param(t.issuePanelArtifacts.id, 'id')),
      ),
    )
    .prepare(),
)
const deferredExists = prepared((db, t) =>
  db
    .select({ id: t.issuePanelDeferred.id })
    .from(t.issuePanelDeferred)
    .where(
      inWorkspace(
        t.issuePanelDeferred,
        eq(t.issuePanelDeferred.id, param(t.issuePanelDeferred.id, 'id')),
      ),
    )
    .prepare(),
)

/** Tables are the only home. Read grouping and ordering happen in SQL. */
export class IssuePanelRepository {
  private readonly db: WorkspaceDb
  constructor(queries: WorkspaceQueries) {
    this.db = queries.db
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
    // Parsed, so the stored row's workspace_id stays out of the record.
    const row = await toggleTodo(this.db).get({ issueId, id, done })
    return row ? IssuePanelTodoWire.parse(row) : undefined
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
