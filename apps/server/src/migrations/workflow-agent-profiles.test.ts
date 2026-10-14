/**
 * EXECUTION PROFILES ARE GONE; WORKFLOW STEPS PIN AGENT PROFILES (POD-6114).
 *
 * The migration adds `workflow_run_steps.agent_profile_id/_json`, carries a run
 * step's old `execution_profile_id` over, then drops `execution_profiles` and
 * the two `execution_profile_id` columns (a reviewed contract step). These
 * tests run it on a database that has the old shape and a row in it.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const AT = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_workflow-agent-profiles'))

const columns = (db: SqlDatabase, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

const tableExists = (db: SqlDatabase, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null

describe('the workflow-agent-profiles migration', () => {
  it('is in the manifest', () => {
    expect(AT).toBeGreaterThan(0)
  })

  it('carries a run step’s profile reference over and drops the old table and columns', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, AT))
    expect(tableExists(db, 'execution_profiles')).toBe(true)
    expect(columns(db, 'sessions')).toContain('execution_profile_id')
    // A step row in the old shape. The run it belongs to is beside the point
    // here, so the foreign key is off for this one insert.
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(
      `INSERT INTO workflow_run_steps (run_id, step_id, position, title, status, execution_profile_id, execution_profile_json)
       VALUES ('wrun_1', 'review', 0, 'Review', 'pending', 'wfp_1', '{"id":"wfp_1"}'),
              ('wrun_1', 'build', 1, 'Build', 'pending', NULL, NULL)`,
    ).run()
    db.exec('PRAGMA foreign_keys = ON')

    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, AT + 1))).toEqual([
      DRIZZLE_MIGRATIONS[AT]?.name,
    ])

    expect(tableExists(db, 'execution_profiles')).toBe(false)
    expect(columns(db, 'sessions')).not.toContain('execution_profile_id')
    expect(columns(db, 'sessions')).toContain('agent_profile_id')
    const steps = columns(db, 'workflow_run_steps')
    expect(steps).not.toContain('execution_profile_id')
    expect(steps).not.toContain('execution_profile_json')
    expect(steps).toEqual(expect.arrayContaining(['agent_profile_id', 'agent_profile_json']))
    // The reference survives (it reads as "unavailable": it names no agent
    // profile); the old snapshot, a different shape, does not.
    expect(
      db
        .prepare(
          'SELECT step_id, agent_profile_id, agent_profile_json FROM workflow_run_steps ORDER BY position',
        )
        .all(),
    ).toEqual([
      { step_id: 'review', agent_profile_id: 'wfp_1', agent_profile_json: null },
      { step_id: 'build', agent_profile_id: null, agent_profile_json: null },
    ])
    db.close()
  })

  it('applies on a fresh database and a second boot applies nothing', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(tableExists(db, 'execution_profiles')).toBe(false)
    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).toEqual([])
    db.close()
  })
})
