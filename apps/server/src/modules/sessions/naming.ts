/**
 * THE CURATED SESSION NAME SLOT AND ITS PROVENANCE (POD-1396, from POD-1385's
 * god-object audit). [spec:SP-eb60] [spec:SP-4ef9]
 *
 * One rule, and it is the whole reason this is a module rather than two
 * setters: **a user-set name is sovereign.** `nameSource` records who wrote the
 * name, and that stamp decides every subsequent write:
 *
 *   nameSource 'user'      an agent can NEVER overwrite it. Refused, forever.
 *   nameSource 'agent'     an agent MAY retitle its own earlier name as the
 *                          work becomes clear.
 *   nameSource undefined   nobody has named it; an agent may.
 *
 * Clearing (name = '') also clears the source, so the session becomes unnamed
 * again and an agent may name it — the prime will ask it to.
 *
 * WHY IT IS ONE JOB. The two entry points look like independent setters and are
 * not: they write the SAME slot and are only distinguishable by the provenance
 * rule between them. Splitting them leaves the rule with no home and invites a
 * third writer that honours neither. `normalizeAgentName` belongs here for the
 * same reason — it is the agent path's half of the contract, and `createSession`
 * needs it for a spawner-prescribed name before any session object exists.
 *
 * REFUSAL IS A RETURNED REASON, NEVER A THROW. The CLI prints it and the agent
 * carries on; an exception here would abort a turn over a naming collision.
 */

import type { SessionId } from '@podium/model'
import { MAX_AGENT_TITLE_LENGTH } from '@podium/protocol'
import type { Session } from './session'

export type AgentNameResult = { ok: true; name: string } | { ok: false; reason: string }

/**
 * Collapse whitespace, reject empty / over-long. Shared by the agent self-title
 * path and createSession's spawner-prescribed name.
 *
 * Exported as a free function because `createSession` validates a name BEFORE a
 * Session object exists to mutate — it has no instance to reach through.
 */
export function normalizeAgentName(name: string): AgentNameResult {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) return { ok: false, reason: 'title is empty' }
  if (clean.length > MAX_AGENT_TITLE_LENGTH) {
    return {
      ok: false,
      reason: `title exceeds ${MAX_AGENT_TITLE_LENGTH} characters — a session title is 3–5 words`,
    }
  }
  return { ok: true, name: clean }
}

export interface SessionNamingPorts {
  session(sessionId: SessionId): Session | undefined
  /**
   * Apply a metadata write inside the write funnel, persist it, and broadcast.
   * Both paths go through this one seam so a name change can never persist
   * without the broadcast that makes it visible.
   */
  mutate(sessionId: SessionId, write: (session: Session) => void | (() => void)): void
}

export class SessionNaming {
  constructor(private readonly ports: SessionNamingPorts) {}

  /**
   * A HUMAN names the session (web rename, superagent `rename_session`) — the
   * curated slot, stamped `nameSource = 'user'`. That stamp is sovereign:
   * {@link setAgentName} refuses against it forever after.
   */
  rename({ sessionId, name }: { sessionId: SessionId; name: string }): void {
    this.ports.mutate(sessionId, (session) => {
      const clean = name.trim()
      session.name = clean
      session.nameSource = clean ? 'user' : undefined
    })
  }

  /**
   * The AGENT names its own session — `podium session title "…"`, relayed as
   * sessions.title and bound to the calling session by the capability.
   *
   * Writes the same curated `name` slot the user writes, so it wins in the UI
   * over the derived `title` — but stamped 'agent', and REFUSED when the user
   * already named it.
   */
  setAgentName({ sessionId, name }: { sessionId: SessionId; name: string }): {
    ok: boolean
    name?: string
    reason?: string
  } {
    const session = this.ports.session(sessionId)
    if (!session) return { ok: false, reason: 'session not found' }
    const norm = normalizeAgentName(name)
    if (!norm.ok) return { ok: false, reason: norm.reason }
    // User-set names are sovereign: refuse, never throw, never overwrite.
    if (session.nameSource === 'user') {
      return {
        ok: false,
        name: session.name,
        reason: `this session was named by the user ("${session.name}") — an agent cannot rename it`,
      }
    }
    this.ports.mutate(sessionId, (s) => {
      s.name = norm.name
      s.nameSource = 'agent'
    })
    return { ok: true, name: norm.name }
  }
}
