/**
 * WHICH BINARY EACH SESSION RUNS (managed installs §6.2, POD-7272).
 *
 * The daemon forgets its sessions' contexts when it restarts while their
 * harness processes live on in their hosts, so "which install does this
 * session run" is kept in the install ledger, one row per session:
 *
 * - written when a process starts, by the one step every launch runs before
 *   its process exists (`prepareLaunch`, session-posture.ts), from the
 *   installation the command was bound to;
 * - removed when the session's processes are stopped;
 * - at daemon start, dropped for the sessions whose process did not survive.
 *
 * Two readers: housekeeping never deletes a release a row names, and a
 * restarted daemon rebuilds a surviving session's context from its row, so
 * the context names the binary that really runs.
 *
 * Each call opens the ledger and closes it again, as the inventory's read
 * does: the CLI writes the same database, and nothing is held between calls.
 * A failure is logged and never stops a launch: the session still starts, and
 * the cost is a release housekeeping might not know to keep.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessInstallation } from '@podium/harness'
import {
  defaultHarnessesDir,
  finishPendingRemovals,
  InstallLedger,
  LEDGER_FILE,
  type SessionInstall,
} from '@podium/harness/inventory'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'

const log = createLogger('daemon:session-installs')

/** The daemon's view of the session rows in the install ledger. */
export interface SessionInstallRecords {
  /** Record the installation a process of `sessionId` is starting on. */
  record(sessionId: SessionId, installation: HarnessInstallation): void
  /** The session's processes are gone. */
  remove(sessionId: SessionId): void
  /** Drop the rows of sessions whose process did not survive a restart. */
  drop(sessionIds: readonly SessionId[]): void
  get(sessionId: SessionId): SessionInstall | undefined
  list(): SessionInstall[]
}

/** The row recorded for a process of `sessionId` started on `installation`. */
export function sessionInstallRow(
  sessionId: SessionId,
  installation: HarnessInstallation,
): SessionInstall {
  return {
    sessionId,
    kind: installation.kind,
    executable: installation.executable,
    version: installation.version,
    provenance: installation.provenance,
    release: installation.provenance === 'managed' ? (installation.release ?? null) : null,
  }
}

/** The installation a session's row names, as of command-environment `generation`. */
export function recordedInstallation(row: SessionInstall, generation: number): HarnessInstallation {
  return {
    kind: row.kind,
    executable: row.executable,
    version: row.version,
    generation,
    provenance: row.provenance,
    ...(row.release !== null ? { release: row.release } : {}),
  }
}

/**
 * The session rows of the ledger in `harnessesDir` (default
 * `<state>/harnesses`). A read on a machine with no ledger creates none.
 */
export function ledgerSessionInstalls(
  harnessesDir: string = defaultHarnessesDir(),
): SessionInstallRecords {
  const ledgerExists = () => existsSync(join(harnessesDir, LEDGER_FILE))
  const withLedger = <T>(
    what: string,
    fields: Record<string, unknown>,
    use: (ledger: InstallLedger) => T,
  ): T | undefined => {
    try {
      const ledger = InstallLedger.open({ harnessesDir })
      try {
        return use(ledger)
      } finally {
        ledger.close()
      }
    } catch (err) {
      log.warn(`could not ${what} in the install ledger`, { err, ...fields })
      return undefined
    }
  }
  return {
    record(sessionId, installation) {
      if (installation.provenance === 'managed') {
        const ledger = InstallLedger.open({ harnessesDir })
        try {
          ledger.recordSessionInstall(sessionInstallRow(sessionId, installation))
        } finally {
          ledger.close()
        }
      } else {
        withLedger('record the session install', { sessionId }, (ledger) =>
          ledger.recordSessionInstall(sessionInstallRow(sessionId, installation)),
        )
      }
    },
    remove(sessionId) {
      if (!ledgerExists()) return
      withLedger('remove the session install', { sessionId }, (ledger) =>
        ledger.removeSessionInstall(sessionId),
      )
      finishPendingRemovals(harnessesDir)
    },
    drop(sessionIds) {
      if (sessionIds.length === 0 || !ledgerExists()) return
      withLedger('drop session installs', { sessionIds }, (ledger) => {
        for (const sessionId of sessionIds) ledger.removeSessionInstall(sessionId)
      })
      finishPendingRemovals(harnessesDir)
    },
    get(sessionId) {
      if (!ledgerExists()) return undefined
      return withLedger('read the session install', { sessionId }, (ledger) =>
        ledger.sessionInstall(sessionId),
      )
    },
    list() {
      if (!ledgerExists()) return []
      return withLedger('list session installs', {}, (ledger) => ledger.sessionInstalls()) ?? []
    },
  }
}

/**
 * THE ROWS OF SESSIONS THAT DID NOT SURVIVE A RESTART GO (§6.2). Of the rows
 * a previous daemon left (`inherited`, read before this daemon started any
 * process), those whose session has no process running are dropped, so
 * housekeeping may delete a release nothing runs on. Rows written since are
 * not looked at, and survivors' rows stay. A session whose liveness cannot be
 * read keeps its row: a kept row costs a kept folder, a dropped one a deleted
 * release under a running process. Returns the dropped session ids.
 */
export async function dropInstallsOfLostSessions(
  records: Pick<SessionInstallRecords, 'drop'>,
  inherited: readonly SessionId[],
  alive: (sessionId: SessionId) => Promise<boolean>,
): Promise<SessionId[]> {
  const lost: SessionId[] = []
  for (const sessionId of inherited) {
    try {
      if (!(await alive(sessionId))) lost.push(sessionId)
    } catch (err) {
      log.warn('could not tell whether a session survived the restart', { err, sessionId })
    }
  }
  records.drop(lost)
  if (lost.length > 0)
    log.info('dropped the install rows of sessions that did not survive', { sessions: lost })
  return lost
}
