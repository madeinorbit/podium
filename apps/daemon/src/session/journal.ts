/**
 * THE ENGINE BINDING JOURNAL (1.5, spec §4.8).
 *
 * Lives in the session layer so the session layer owns where the bytes live:
 * a file per session, 0600, under the daemon's own state dir (so it moves with
 * the instance and is swept with it). Synchronous on purpose — it is written
 * on the turn-open path, where the value it protects is the monotonic turn
 * epoch.
 *
 * ONE generic factory, not three copies: the entry SHAPE is each family's
 * knowledge (its `*JournalEntry`), while the namespace — the only per-family
 * value here — arrives from the family's own facts. Moved here from
 * `runtime/host.ts` so `session/` never imports the runtime wiring
 * (session → runtime → control → session was a cycle); `runtime/host.ts`
 * re-exports it for its existing callers.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'

const engineLog = createLogger('daemon:engine-supervision')

export function createEngineJournal<TEntry extends { sessionId: SessionId }>(input: {
  namespace: string
}): {
  read(sessionId: SessionId): TEntry | undefined
  write(entry: TEntry): void
  clear(sessionId: SessionId): void
} {
  const dir = (): string => join(stateDir(), input.namespace)
  const path = (sessionId: SessionId): string =>
    join(dir(), `${encodeURIComponent(sessionId)}.json`)
  const cache = new Map<SessionId, TEntry>()
  return {
    read(sessionId) {
      const cached = cache.get(sessionId)
      if (cached) return cached
      try {
        const parsed = JSON.parse(readFileSync(path(sessionId), 'utf8')) as TEntry
        cache.set(sessionId, parsed)
        return parsed
      } catch {
        return undefined
      }
    },
    write(entry) {
      cache.set(entry.sessionId, entry)
      try {
        mkdirSync(dir(), { recursive: true, mode: 0o700 })
        writeFileSync(path(entry.sessionId), JSON.stringify(entry), { mode: 0o600 })
      } catch (err) {
        // A journal we cannot write costs `adopt()` after a restart and
        // nothing else — the live session is unaffected. Losing the session
        // to an ENOSPC would be the worse trade.
        engineLog.warn('could not persist the engine binding journal', {
          err,
          namespace: input.namespace,
          sessionId: entry.sessionId,
        })
      }
    },
    clear(sessionId) {
      cache.delete(sessionId)
      try {
        rmSync(path(sessionId), { force: true })
      } catch {
        // Best effort: a stale entry fails its adopt probe and is ignored anyway.
      }
    },
  }
}
