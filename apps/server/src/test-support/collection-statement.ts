/**
 * A collection statement (`sync/collection-sql.ts`) run on a test store, on the run's
 * engine [POD-7118]: its positional parameters bound as drizzle values, so each engine
 * renders its own placeholders, and its workspace marker bound to the store's workspace.
 */
import {
  isBoundParam,
  PG_RULE_SQL,
  type RuleSqlDialect,
  SQLITE_RULE_SQL,
  type SqlValue,
} from '@podium/sync/collections'
import { type SQL, sql } from 'drizzle-orm'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import { storeSql } from './store-sql'

/** The rule compiler's dialect for the store's engine. */
export const ruleDialectOfStore = (store: SessionStore): RuleSqlDialect =>
  storeSql(store).engine === 'pg' ? PG_RULE_SQL : SQLITE_RULE_SQL

/** `text` with each `?` bound to the next of `params`, the workspace marker to the store's. */
export function boundStatement(text: string, params: readonly SqlValue[]): SQL {
  const parts = text.split('?')
  if (parts.length - 1 !== params.length) {
    throw new Error(`statement has ${parts.length - 1} placeholders and ${params.length} values`)
  }
  const chunks: SQL[] = []
  for (const [at, part] of parts.entries()) {
    if (at > 0) {
      const value = params[at - 1]
      chunks.push(sql`${isBoundParam(value) ? SELF_HOSTED_WORKSPACE_ID : value}`)
    }
    chunks.push(sql.raw(part))
  }
  return sql.join(chunks)
}

/** Every row of a collection statement on `store`. */
export async function runCollectionStatement<T>(
  store: SessionStore,
  statement: { readonly sql: string; readonly params: readonly SqlValue[] },
): Promise<T[]> {
  return await storeSql(store).all<T>(boundStatement(statement.sql, statement.params))
}
