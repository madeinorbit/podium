/**
 * Automations aggregate (#470) [spec:SP-17db] — owns the `automations` and
 * `automation_runs` tables (migration 022). Pure persistence: the schedule
 * SEMANTICS (cron parsing, the due/missed/overlap decision, the spawn) live in
 * modules/automations/.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

/** How a fire ended. `missed` and `skipped_overlap` are recorded WITHOUT a spawn —
 *  the run history is honest about the fires that deliberately did nothing. */
export type AutomationRunOutcome = 'spawned' | 'missed' | 'skipped_overlap' | 'error'

/** One scheduled automation (camelCase mirror of the `automations` table). */
export interface AutomationRow {
  id: string
  name: string
  enabled: boolean
  /** null = GLOBAL: the session spawns in the user's home directory [spec:SP-17db]. */
  repoPath: string | null
  /** Standard 5-field cron, evaluated in SERVER-LOCAL time. */
  cron: string
  agentKind: string
  /** 'auto' = inherit the settings default (no per-spawn override). */
  model: string
  effort: string
  prompt: string
  /** ISO. null = not armed (disabled, or an unparseable cron disarmed it). */
  nextRunAt: string | null
  lastRunAt: string | null
  createdAt: string
}

/** One fire of an automation — the row behind the tab's "Recent runs" list. */
export interface AutomationRunRow {
  id: string
  automationId: string
  firedAt: string
  /** null unless outcome = 'spawned'. */
  sessionId: string | null
  outcome: AutomationRunOutcome
  /** Error message, or why the fire was skipped. */
  detail: string | null
}

function rowToAutomation(r: Record<string, unknown>): AutomationRow {
  return {
    id: r.id as string,
    name: r.name as string,
    enabled: Number(r.enabled) !== 0,
    repoPath: (r.repo_path as string | null) ?? null,
    cron: r.cron as string,
    agentKind: r.agent_kind as string,
    model: r.model as string,
    effort: r.effort as string,
    prompt: r.prompt as string,
    nextRunAt: (r.next_run_at as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }
}

function rowToRun(r: Record<string, unknown>): AutomationRunRow {
  return {
    id: r.id as string,
    automationId: r.automation_id as string,
    firedAt: r.fired_at as string,
    sessionId: (r.session_id as string | null) ?? null,
    outcome: r.outcome as AutomationRunOutcome,
    detail: (r.detail as string | null) ?? null,
  }
}

export class AutomationsRepository {
  constructor(private readonly db: SqlDatabase) {}

  list(): AutomationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM automations ORDER BY created_at ASC')
      .all() as Record<string, unknown>[]
    return rows.map(rowToAutomation)
  }

  get(id: string): AutomationRow | undefined {
    const r = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? rowToAutomation(r) : undefined
  }

  insert(a: AutomationRow): void {
    this.db
      .prepare(
        `INSERT INTO automations
           (id, name, enabled, repo_path, cron, agent_kind, model, effort, prompt,
            next_run_at, last_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.name,
        a.enabled ? 1 : 0,
        a.repoPath,
        a.cron,
        a.agentKind,
        a.model,
        a.effort,
        a.prompt,
        a.nextRunAt,
        a.lastRunAt,
        a.createdAt,
      )
  }

  /** Whole-row update (the service reads, patches, writes back). */
  update(a: AutomationRow): void {
    this.db
      .prepare(
        `UPDATE automations SET
           name = ?, enabled = ?, repo_path = ?, cron = ?, agent_kind = ?, model = ?,
           effort = ?, prompt = ?, next_run_at = ?, last_run_at = ?
         WHERE id = ?`,
      )
      .run(
        a.name,
        a.enabled ? 1 : 0,
        a.repoPath,
        a.cron,
        a.agentKind,
        a.model,
        a.effort,
        a.prompt,
        a.nextRunAt,
        a.lastRunAt,
        a.id,
      )
  }

  /** Delete an automation. Its runs go with it (FK ON DELETE CASCADE). */
  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes) > 0
  }

  // ---- runs ----

  addRun(run: AutomationRunRow): void {
    this.db
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, fired_at, session_id, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.automationId, run.firedAt, run.sessionId, run.outcome, run.detail)
  }

  /** Most recent runs first — the tab's "Recent runs" list. */
  listRuns(automationId: string, limit = 20): AutomationRunRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?',
      )
      .all(automationId, limit) as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  /** The session id of the LATEST spawned run, per automation — the overlap check's
   *  input ("is the previous run's session still live?"). Automations that never
   *  spawned are absent from the map. Latest = highest rowid (insertion order), not
   *  MAX(fired_at): two fires can share a timestamp, and insertion order is the
   *  truth about which ran last. */
  lastSpawnedSessions(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT automation_id, session_id FROM automation_runs r
         WHERE outcome = 'spawned' AND session_id IS NOT NULL
           AND rowid = (
             SELECT MAX(rowid) FROM automation_runs x
             WHERE x.automation_id = r.automation_id
               AND x.outcome = 'spawned' AND x.session_id IS NOT NULL
           )`,
      )
      .all() as Record<string, unknown>[]
    return new Map(rows.map((r) => [r.automation_id as string, r.session_id as string]))
  }
}
