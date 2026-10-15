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
import { and, eq, isNull, sql } from 'drizzle-orm'
import { agentProfiles, issues } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].
const P = (name: string) => sql.placeholder(name)

const allProfiles = prepared((db: StoreDrizzle) =>
  db.select().from(agentProfiles).orderBy(agentProfiles.name).prepare(),
)

const profileById = prepared((db: StoreDrizzle) =>
  db.select().from(agentProfiles).where(eq(agentProfiles.id, param(agentProfiles.id, 'id'))).prepare(),
)

const profileByName = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(agentProfiles)
    .where(sql`${agentProfiles.name} = ${param(agentProfiles.name, 'name')} COLLATE NOCASE`)
    .prepare(),
)

const insertProfile = prepared((db: StoreDrizzle) =>
  db
    .insert(agentProfiles)
    .values({
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
    })
    .prepare(),
)

const updateProfile = prepared((db: StoreDrizzle) =>
  db
    .update(agentProfiles)
    .set({
      name: P('name'),
      description: P('description'),
      candidatesJson: P('candidatesJson'),
      machineId: P('machineId'),
      instructions: P('instructions'),
      updatedBy: P('actor'),
      updatedAt: P('now'),
    })
    .where(eq(agentProfiles.id, param(agentProfiles.id, 'id')))
    .prepare(),
)

const deleteProfile = prepared((db: StoreDrizzle) =>
  db.delete(agentProfiles).where(eq(agentProfiles.id, param(agentProfiles.id, 'id'))).prepare(),
)

const liveIssuesUsingProfile = prepared((db: StoreDrizzle) =>
  db
    .select({ seq: issues.seq, stage: issues.stage, closedReason: issues.closedReason })
    .from(issues)
    .where(and(eq(issues.agentProfileId, param(issues.agentProfileId, 'id')), isNull(issues.deletedAt)))
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
  private readonly rootDb: StoreDrizzle

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
  }

  /** One instance for the store's life: the executor routes each statement to
   *  the enclosing transaction as it runs [POD-6147]. */
  protected get db(): StoreDrizzle {
    return this.rootDb
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
