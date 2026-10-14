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
import { currentTransaction } from './executor/sync-drizzle'

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

export class AgentProfilesRepository {
  private readonly rootDb: StoreDrizzle

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
  }

  /** Resolves the enclosing transaction on every access [spec rule 34a]. */
  protected get db(): StoreDrizzle {
    return currentTransaction() ?? this.rootDb
  }

  async list(): Promise<AgentProfileWire[]> {
    return (await this.db.select().from(agentProfiles).orderBy(agentProfiles.name).all()).map(
      toProfile,
    )
  }

  async get(id: string): Promise<AgentProfileWire | null> {
    const row = await this.db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).get()
    return row ? toProfile(row) : null
  }

  async getByName(name: string): Promise<AgentProfileWire | null> {
    const row = await this.db
      .select()
      .from(agentProfiles)
      .where(sql`${agentProfiles.name} = ${name} COLLATE NOCASE`)
      .get()
    return row ? toProfile(row) : null
  }

  async insert(
    input: AgentProfileRowInput & { actor: string; now: string },
  ): Promise<AgentProfileWire> {
    await this.db
      .insert(agentProfiles)
      .values({
        id: input.id,
        name: input.name,
        description: input.description,
        candidatesJson: JSON.stringify(input.candidates),
        machineId: input.machineId,
        instructions: input.instructions,
        createdBy: input.actor,
        updatedBy: input.actor,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run()
    return (await this.get(input.id)) as AgentProfileWire
  }

  /** Replaces every editable field. False when the row is gone. */
  async update(input: AgentProfileRowInput & { actor: string; now: string }): Promise<boolean> {
    const result = await this.db
      .update(agentProfiles)
      .set({
        name: input.name,
        description: input.description,
        candidatesJson: JSON.stringify(input.candidates),
        machineId: input.machineId,
        instructions: input.instructions,
        updatedBy: input.actor,
        updatedAt: input.now,
      })
      .where(eq(agentProfiles.id, input.id))
      .run()
    return result.changes > 0
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.delete(agentProfiles).where(eq(agentProfiles.id, id)).run()).changes > 0
  }

  /** Seqs of the live, open issues that point at this profile (deletion guard).
   *  "Open" is the model's one closed predicate, applied here rather than
   *  restated in SQL. */
  async openIssueSeqsUsing(id: string): Promise<number[]> {
    const rows = await this.db
      .select({ seq: issues.seq, stage: issues.stage, closedReason: issues.closedReason })
      .from(issues)
      .where(and(eq(issues.agentProfileId, id), isNull(issues.deletedAt)))
      .all()
    return rows.filter((r) => !isIssueClosed(r)).map((r) => r.seq)
  }
}
