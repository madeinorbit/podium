/**
 * The asks_user derivation and the SQLite triggers that maintain it (POD-7123).
 *
 * The shipping SQLite schema is frozen in 20261117220206_session-asks-user and its
 * workspace rebuild, 20261118101338_workspace-keys. This declaration renders that
 * complete view and trigger set; the census compares it with the installed schema.
 * Postgres uses the same inputs and expression in captureWrite, without triggers.
 */
import { type RuleSqlDialect, SQLITE_RULE_SQL } from '@podium/sync/collections'
import { type SQL, sql } from 'drizzle-orm'

export const ASKING_INPUTS = [
  {
    table: 'sessions',
    trigger: 'sessions',
    sessionKey: 'id',
    columns: ['agent_state_json', 'last_input_at', 'archived', 'deleted_at'],
    delete: false,
  },
  {
    table: 'offers',
    trigger: 'offers',
    sessionKey: 'session_id',
    columns: ['session_id', 'created_at'],
    delete: true,
  },
  {
    table: 'runtime_event_checkpoints',
    trigger: 'runtime',
    sessionKey: 'session_id',
    columns: ['session_id', 'turn_state_json'],
    delete: true,
  },
  {
    table: 'session_observation_checkpoints',
    trigger: 'checkpoint',
    sessionKey: 'session_id',
    columns: ['session_id', 'checkpoint_json'],
    delete: true,
  },
] as const

/** Whether the SQLite trigger for this operation can fire. */
export function askingNeeded(
  table: string,
  op: 'i' | 'u' | 'd',
  setColumns?: readonly string[],
): boolean {
  const input = ASKING_INPUTS.find((input) => input.table === table)
  if (input === undefined) return false
  if (op === 'd') return input.delete
  return (
    op === 'i' ||
    setColumns === undefined ||
    setColumns.some((column) => (input.columns as readonly string[]).includes(column))
  )
}

const q = (name: string) => `"${name}"`

/** Pure SQL renderers; neither executes the expression it names. */
export type AskingRowRef = (column: string) => string
export type AskingRelation = (table: string) => string
export const askingRef =
  (alias: string): AskingRowRef =>
  (column) =>
    `${alias}.${q(column)}`

/**
 * The migration's view, over a session relation and its three satellite relations.
 * On Postgres a written satellite is its post-write image (RETURNING overlaid on the
 * statement snapshot), and a session write supplies its proposed column values.
 * JSON objects alone override the next source; SQL NULL, JSON null and scalars fall
 * through. An empty offer timestamp is never an offer in the published record.
 */
export function askingSelect(
  d: RuleSqlDialect,
  from: SQL,
  row: AskingRowRef = askingRef('r'),
  relation: AskingRelation = q,
): SQL {
  const same = (alias: string) =>
    `${alias}.workspace_id = ${row('workspace_id')} AND ${alias}.session_id = ${row('id')}`
  const phase = d.jsonTextPath('agent_state', ['phase'])
  const idle = d.jsonTextPath('agent_state', ['idle', 'kind'])
  return sql`${sql.raw(`SELECT workspace_id, session_id,
    CASE WHEN deleted_at IS NULL AND archived = ${d.bool(false)} AND (
      offered OR ${phase} IN ('needs_user', 'errored')
      OR (${phase} = 'idle' AND ${idle} IN ('question', 'approval'))
    ) THEN ${d.bool(true)} ELSE ${d.bool(false)} END AS asks
    FROM (
      SELECT ${row('workspace_id')}, ${row('id')} AS session_id, ${row('deleted_at')}, ${row('archived')},
        EXISTS (SELECT 1 FROM ${relation('offers')} AS o
          WHERE ${same('o')} AND o.created_at <> ${d.timestampFloor}
            AND (${row('last_input_at')} IS NULL OR NOT (${row('last_input_at')} > o.created_at))) AS offered,
        coalesce(
          (SELECT ${d.jsonObject('rt.turn_state_json')}
            FROM ${relation('runtime_event_checkpoints')} AS rt WHERE ${same('rt')}),
          (SELECT ${d.jsonObjectMember('oc.checkpoint_json', 'turnState')}
            FROM ${relation('session_observation_checkpoints')} AS oc WHERE ${same('oc')}),
          ${d.jsonObject(row('agent_state_json'))}
        ) AS agent_state
      FROM `)}${from}${sql.raw(d.name === 'pg' ? ') AS __asks_state' : ')')}`
}

/** The whole SQLite schema, for a strict comparison with the shipping migrations. */
export function sqliteAskingSchema(render: (query: SQL) => string): ReadonlyMap<string, string> {
  const view = render(askingSelect(SQLITE_RULE_SQL, sql.raw('sessions AS r')))
  const out = new Map<string, string>([
    ['session_asks_user', `CREATE VIEW session_asks_user AS ${view}`],
  ])
  const value = `(SELECT v.asks FROM session_asks_user AS v WHERE v.workspace_id = sessions.workspace_id AND v.session_id = sessions.id)`
  for (const input of ASKING_INPUTS) {
    for (const op of ['i', 'u', ...(input.delete ? (['d'] as const) : [])] as const) {
      const name = `asks_user__${input.trigger}__${op}`
      const verb =
        op === 'i'
          ? 'INSERT'
          : op === 'd'
            ? 'DELETE'
            : `UPDATE OF ${input.columns.map(q).join(', ')}`
      const side = op === 'd' ? 'OLD' : 'NEW'
      const target = (side: string) =>
        `sessions.workspace_id = ${side}.workspace_id AND sessions.id = ${side}.${input.sessionKey}`
      const where =
        op === 'u' && input.table !== 'sessions'
          ? `((${target('OLD')}) OR (${target('NEW')}))`
          : target(side)
      const when =
        op === 'u'
          ? ` WHEN ${input.columns.map((column) => `OLD.${q(column)} IS NOT NEW.${q(column)}`).join(' OR ')}`
          : ''
      out.set(
        name,
        `CREATE TRIGGER ${q(name)} AFTER ${verb} ON ${q(input.table)} FOR EACH ROW${when}
          BEGIN UPDATE sessions SET asks_user = ${value}
            WHERE ${where} AND sessions.asks_user IS NOT ${value}; END`,
      )
    }
  }
  return out
}
