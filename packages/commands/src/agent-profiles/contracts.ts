/**
 * AGENT PROFILES (POD-6107, flight deck decisions D3/D4).
 *
 * A profile is a named agent setup (ordered harness/model/effort candidates, an
 * optional machine, optional instructions) that issues and sessions point at.
 * Since POD-6676 it is a synced record: its writes are the generic edits
 * `records.agentProfile.create/edit/remove` (`../records/kinds.ts`,
 * `AGENT_PROFILE_RECORD`), and the four commands that were here
 * (`agentProfiles.create · update · delete · import`) are gone. The CLI's reads
 * (`list`, `show`, `export`) are a query table on the server.
 */

import { z } from 'zod'

/** A profile by id or by name (names are unique, so either addresses one row). */
export const AgentProfileRef = z.string().trim().min(1).max(100)
