import { asIssueId, IssueGitState, type IssueGitStateProjection } from '@podium/model'
import type { WriteScope } from '@podium/sync'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { issueGitStates, issues } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  prepared,
  preparedFamily,
} from './executor/sync-drizzle'

const columns = {
  id: issueGitStates.issueId,
  facts: issueGitStates.factsJson,
  updatedAt: issueGitStates.updatedAt,
}

const byIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select(columns)
    .from(issueGitStates)
    .innerJoin(issues, eq(issues.id, issueGitStates.issueId))
    .where(and(inListOf(issueGitStates.issueId, size), isNull(issues.deletedAt)))
    .prepare(),
)

const pageOf = preparedFamily((db: StoreDrizzle, phase: 'start' | 'after') =>
  db
    .select(columns)
    .from(issueGitStates)
    .innerJoin(issues, eq(issues.id, issueGitStates.issueId))
    .where(
      and(
        isNull(issues.deletedAt),
        phase === 'after'
          ? gt(issueGitStates.issueId, param(issueGitStates.issueId, 'after'))
          : undefined,
      ),
    )
    .orderBy(asc(issueGitStates.issueId))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** Only fact changes replace the observation time. A repeated probe writes nothing. */
const save = prepared((db: StoreDrizzle) =>
  db
    .insert(issueGitStates)
    .values({
      issueId: sql.placeholder('id'),
      factsJson: sql.placeholder('facts'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: issueGitStates.issueId,
      set: { factsJson: sql`excluded.facts_json`, updatedAt: sql`excluded.updated_at` },
      setWhere: sql`${issueGitStates.factsJson} <> excluded.facts_json`,
    })
    .returning(columns)
    .prepare(),
)

function recordOf(row: { id: string; facts: string; updatedAt: string }): IssueGitStateProjection {
  return {
    id: asIssueId(row.id),
    ...IssueGitState.parse({ ...JSON.parse(row.facts), updatedAt: row.updatedAt }),
  }
}

/** Last event-driven git observation, durable independently of the sync log. */
export class IssueGitStatesRepository {
  private readonly db: StoreDrizzle
  constructor(queries: StoreQueries) {
    this.db = queries.rootDb
  }

  async getMany(ids: readonly string[]): Promise<Map<string, IssueGitStateProjection>> {
    if (ids.length === 0) return new Map()
    const size = inListSize(ids.length)
    return new Map(
      (await byIds(this.db, size).all(inListValues(ids, size))).map((row) => [
        row.id,
        recordOf(row),
      ]),
    )
  }

  async get(id: string): Promise<IssueGitState | undefined> {
    const record = (await this.getMany([id])).get(id)
    if (!record) return undefined
    const { id: _id, ...state } = record
    return state
  }

  async set(
    _scope: WriteScope,
    id: string,
    state: IssueGitState,
  ): Promise<IssueGitStateProjection | undefined> {
    const { updatedAt, ...facts } = IssueGitState.parse(state)
    const row = await save(this.db).get({
      id: asIssueId(id),
      facts: JSON.stringify(facts),
      updatedAt,
    })
    return row ? recordOf(row) : undefined
  }

  async *pages(pageSize = 500): AsyncGenerator<IssueGitStateProjection[]> {
    let after: string | undefined
    for (;;) {
      const rows = await pageOf(this.db, after === undefined ? 'start' : 'after').all({
        after: asIssueId(after ?? ''),
        limit: pageSize,
      })
      if (rows.length) yield rows.map(recordOf)
      if (rows.length < pageSize) return
      after = rows[rows.length - 1]!.id
    }
  }
}
