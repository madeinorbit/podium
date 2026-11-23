// workspace-scoped (POD-6959)

/**
 * AGENT PROFILES — the `agent_profiles` table (POD-6107). Rows only: the rules
 * (who may write, name and candidate validation, refusing a delete in use) are
 * `AgentProfileService`'s.
 */
import {
  AgentCandidates,
  type AgentProfileWire,
  isIssueClosed,
  type MachineId,
} from '@podium/model'
import { type Column, eq, isNull, type Param, type SQL, sql } from 'drizzle-orm'
import type { agentProfiles } from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { dialectOf } from './executor/dialect-prepared'
import type { StoreDrizzle, WorkspaceDb, WorkspaceQueries } from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].
const P = (name: string) => sql.placeholder(name)

const allProfiles = prepared((db, t) =>
  db
    .select()
    .from(t.agentProfiles)
    .where(inWorkspace(t.agentProfiles))
    .orderBy(t.agentProfiles.name)
    .prepare(),
)

const profileById = prepared((db, t) =>
  db
    .select()
    .from(t.agentProfiles)
    .where(inWorkspace(t.agentProfiles, eq(t.agentProfiles.id, param(t.agentProfiles.id, 'id'))))
    .prepare(),
)

/**
 * A profile's name folded for a case-blind lookup: `lower()` on both engines, which
 * folds ASCII only, as SQLite's `COLLATE NOCASE` did, so the same names collide on
 * both. On Postgres the folded text is compared in byte order (`COLLATE "C"`,
 * POD-6958 design 2.3 rule 13).
 */
const folded = (db: StoreDrizzle, text: Column | Param): SQL =>
  dialectOf(db) === 'pg' ? sql`lower(${text}) COLLATE "C"` : sql`lower(${text})`

const profileByName = prepared((db, t) =>
  db
    .select()
    .from(t.agentProfiles)
    .where(
      inWorkspace(
        t.agentProfiles,
        eq(folded(db, t.agentProfiles.name), folded(db, param(t.agentProfiles.name, 'name'))),
      ),
    )
    .prepare(),
)

const insertProfile = prepared((db, t) =>
  captureWrite(
    db.insert(t.agentProfiles).values({
      workspaceId: WORKSPACE,
      id: P('id'),
      name: P('name'),
      description: P('description'),
      candidatesJson: P('candidatesJson'),
      machineId: P('machineId'),
      instructions: P('instructions'),
      createdBy: P('actor'),
      updatedBy: P('actor'),
      createdAt: P('now'),
      updatedAt: P('now'),
    }),
  ).prepare(),
)

const updateProfile = prepared((db, t) =>
  captureWrite(
    db
      .update(t.agentProfiles)
      .set({
        name: P('name'),
        description: P('description'),
        candidatesJson: P('candidatesJson'),
        machineId: P('machineId'),
        instructions: P('instructions'),
        updatedBy: P('actor'),
        updatedAt: P('now'),
      })
      .where(inWorkspace(t.agentProfiles, eq(t.agentProfiles.id, param(t.agentProfiles.id, 'id')))),
  ).prepare(),
)

const deleteProfile = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.agentProfiles)
      .where(inWorkspace(t.agentProfiles, eq(t.agentProfiles.id, param(t.agentProfiles.id, 'id')))),
  ).prepare(),
)

const liveIssuesUsingProfile = prepared((db, t) =>
  db
    .select({ seq: t.issues.seq, stage: t.issues.stage, closedReason: t.issues.closedReason })
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        eq(t.issues.agentProfileId, param(t.issues.agentProfileId, 'id')),
        isNull(t.issues.deletedAt),
      ),
    )
    .prepare(),
)

function toProfile(row: typeof agentProfiles.$inferSelect): AgentProfileWire {
  let candidates: AgentProfileWire['candidates'] = []
  try {
    candidates = AgentCandidates.parse(JSON.parse(row.candidatesJson))
  } catch {
    // A row this build cannot read (a harness from a newer build) degrades to
    // "no candidates", which resolves to the Settings default, never a throw.
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    candidates,
    machineId: row.machineId ?? null,
    instructions: row.instructions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface AgentProfileRowInput {
  id: string
  name: string
  description: string
  candidates: AgentProfileWire['candidates']
  machineId: MachineId | null
  instructions: string
}

function rowValues(input: AgentProfileRowInput & { actor: string; now: string }) {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    candidatesJson: JSON.stringify(input.candidates),
    machineId: input.machineId,
    instructions: input.instructions,
    actor: input.actor,
    now: input.now,
  }
}

export class AgentProfilesRepository {
  private readonly scope: WorkspaceDb

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
  }

  /** One instance for the store's life: the executor routes each statement to
   *  the enclosing transaction as it runs [POD-6147]. */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  async list(): Promise<AgentProfileWire[]> {
    return (await allProfiles(this.db).all()).map(toProfile)
  }

  async get(id: string): Promise<AgentProfileWire | null> {
    const row = await profileById(this.db).get({ id })
    return row ? toProfile(row) : null
  }

  async getByName(name: string): Promise<AgentProfileWire | null> {
    const row = await profileByName(this.db).get({ name })
    return row ? toProfile(row) : null
  }

  async insert(
    input: AgentProfileRowInput & { actor: string; now: string },
  ): Promise<AgentProfileWire> {
    await insertProfile(this.db).run(rowValues(input))
    return (await this.get(input.id)) as AgentProfileWire
  }

  /** Replaces every editable field. False when the row is gone. */
  async update(input: AgentProfileRowInput & { actor: string; now: string }): Promise<boolean> {
    const result = await updateProfile(this.db).run(rowValues(input))
    return result.changes > 0
  }

  async delete(id: string): Promise<boolean> {
    return (await deleteProfile(this.db).run({ id })).changes > 0
  }

  /** Seqs of the live, open issues that point at this profile (deletion guard).
   *  "Open" is the model's one closed predicate, applied here rather than
   *  restated in SQL. */
  async openIssueSeqsUsing(id: string): Promise<number[]> {
    const rows = await liveIssuesUsingProfile(this.db).all({ id })
    return rows.filter((r) => !isIssueClosed(r)).map((r) => r.seq)
  }
}
