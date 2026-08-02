/**
 * Shapes shared by the session modules that both START a session and OWN it
 * (POD-1396).
 *
 * These lived on `lifecycle.ts` and moved here for one structural reason:
 * `session-start.ts` needs them, `lifecycle.ts` imports `session-start.ts`, and
 * leaving them on lifecycle would have made that pair a CYCLE. The composition
 * graph reports 0 cycles and this decomposition is not going to be what breaks
 * that.
 *
 * `lifecycle.ts` re-exports both so existing importers (`relay.ts`) are
 * unaffected — the move is invisible outside this directory.
 */

import type { AccountId, AgentKind, Geometry, SessionId } from '@podium/model'

/** The geometry a session is born with, before any client reports a real one. */
export const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }

/** What every spawn path returns, fresh spawn and resurrect alike. */
export interface SessionSpawnResult {
  sessionId: SessionId
  agentId: string
  harness: AgentKind
  model: string | null
  effort: string | null
  machine: string
  machineId: string
  accountId: AccountId | null
}
