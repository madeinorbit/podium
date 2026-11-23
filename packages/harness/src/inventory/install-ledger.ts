/**
 * THE INSTALL LEDGER: WHAT ON THIS MACHINE PODIUM OWNS (POD-7268).
 *
 * docs/design/harness-managed-installs.md §7. A small SQLite database at
 * `<state>/harnesses/ledger.db`, beside the release folders it names. It holds
 * which release of each managed harness is current, the versions Podium will not
 * install again, which session runs on which install, and the edits Podium made
 * in the person's own harness folder.
 *
 * Two programs write it: the daemon, and the CLI at machine setup (which can run
 * before a daemon exists). Both open it here. SQLite gives one writer at a time
 * and all-or-nothing writes; the install lock is a lease ROW (owner pid, expiry,
 * renewed while held), never a write transaction held for the minutes an
 * install takes.
 *
 * The release folders are the record of the releases (§5.2). When the database
 * is lost or damaged it is set aside and rebuilt from them: the highest-numbered
 * folder with a valid receipt becomes current, the next one previous. Home-edit
 * and session rows are lost in that case, and the ledger says it was rebuilt
 * until the machine has reported it.
 *
 * A database written by a newer schema is refused, never rewritten.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_HARNESS_KINDS, type BuiltinHarnessKind, type SessionId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase, type SqlStatement } from '@podium/runtime/sqlite'
import type { JsonValue, PostureRequirement } from '../posture-types.js'
import { type InstallReceipt, listReleaseFolders, type ReleaseFolder } from './install-receipt.js'

/** The schema this build writes. A database recording a higher number is refused. */
export const INSTALL_LEDGER_SCHEMA_VERSION = 3

export const LEDGER_FILE = 'ledger.db'

/** `<state>/harnesses`: the release folders and the ledger. */
export function defaultHarnessesDir(): string {
  return join(stateDir(), 'harnesses')
}

/** `<state>/harnesses/ledger.db`. */
export function defaultInstallLedgerPath(): string {
  return join(defaultHarnessesDir(), LEDGER_FILE)
}

// ---------------------------------------------------------------------------
// Rows (§7)

/** One row per managed harness. */
export interface ManagedInstall {
  kind: BuiltinHarnessKind
  /** The number the next release folder gets. */
  /** A person requested removal; never selected for a new process. */
  removingAt?: string
  nextNumber: number
  /** A release folder's number. */
  current: number | null
  previous: number | null
  /** A person paused updates. */
  paused: boolean
  /** The release's own updater cannot be stopped; Podium leaves updates to the vendor. */
  vendorUpdated: boolean
  /**
   * Who asked for the managed install. `ledger-rebuild` marks a row rebuilt from
   * the release folders after the database was lost, when the original request
   * is unknown.
   */
  requested: { by: 'machine-setup' | 'person' | 'ledger-rebuild'; at: string }
  /** Absent until the first check runs. */
  lastCheck?: { at: string; ok: true; latest: string } | { at: string; ok: false; error: string }
  lastInstallError?: { at: string; version: string; error: string }
  /** First failure of the current run of failed checks or installs; cleared on success. */
  failingSince?: string
}

/** Versions Podium will not install again, and why. */
export interface RejectedRelease {
  kind: BuiltinHarnessKind
  version: string
  reason: string
  at: string
}

/** One row per session with a running harness process. */
export interface SessionInstall {
  sessionId: SessionId
  kind: BuiltinHarnessKind
  executable: string
  version: string
  provenance: 'managed' | 'external'
  /** The release folder's number, when managed. */
  release: number | null
}

/** One row per edit Podium made in the person's own harness folder. */
export interface HomeEditRecord {
  harness: BuiltinHarnessKind
  /** The real path written, after following links. */
  file: string
  edit:
    | { kind: 'json-key'; path: string[]; value: JsonValue }
    | { kind: 'toml-array-entry'; path: string[]; value: string }
    | { kind: 'owned-file'; sha256: string }
    /** Podium's handlers in a shared hook file, each one's command holding `marker`. */
    | { kind: 'hook-handlers'; marker: string; events: string[] }
  /**
   * What was there before Podium's first write. A file that was absent may
   * name the outermost folder Podium created for it, which undo removes
   * again while it is empty (POD-7389).
   */
  prior: { absent: true; createdFolder?: string } | { value: JsonValue } | { contents: string }
  serves: HomeEditServes
  appliedAt: string
}

/** What a home edit is for: a posture requirement, or the hooks that report a session's state. */
export type HomeEditServes = PostureRequirement | 'session-state'

/** A stored home edit, with the row id that removes it. */
export interface StoredHomeEdit extends HomeEditRecord {
  id: number
}

/** Why and when the ledger was rebuilt from the release folders. */
export interface LedgerRebuild {
  at: string
  /** `missing`: no database file; `damaged`: the file was unreadable and was set aside. */
  reason: 'missing' | 'damaged'
  /** Where the damaged file was moved, when it was. */
  setAside?: string
  /** What made the old file unreadable. */
  detail?: string
  /** Harnesses that got a row back from their release folders. */
  restored: BuiltinHarnessKind[]
}

// ---------------------------------------------------------------------------
// Install lock

/** Who holds the install lock. */
export interface InstallLockHolder {
  pid: number
  hostname: string
  /** Free text naming the program (`daemon`, `podium machine setup`). */
  label: string
  acquiredAt: string
  /** Epoch milliseconds the lease runs out unless renewed. */
  expiresAtMs: number
}

export interface InstallLock {
  readonly token: string
  readonly holder: InstallLockHolder
  /** Extend the lease. False when it was lost: expired and taken over by another owner. */
  renew(): boolean
  /** Whether this lease is still the lock's owner and has not run out. */
  held(): boolean
  /** Give the lock up. Idempotent. */
  release(): void
}

export type AcquireInstallLockResult =
  | {
      acquired: true
      lock: InstallLock
      /** The previous owner, when its lease was taken over. */
      tookOver?: { from: InstallLockHolder; because: 'expired' | 'owner-gone' }
    }
  | { acquired: false; holder: InstallLockHolder }

export interface AcquireInstallLockOptions {
  label: string
  /** How long the lease lasts without renewal. Default 60 s. */
  leaseMs?: number
  /**
   * Renew automatically on a timer (every third of the lease) until released.
   * Default true. Tests and callers that renew by hand pass false.
   */
  autoRenew?: boolean
}

export const DEFAULT_INSTALL_LEASE_MS = 60_000

/** The lock was lost (taken over) before a write that needs it. Nothing was written. */
export class InstallLockLostError extends Error {
  constructor(message = 'the install lock is no longer held') {
    super(message)
    this.name = 'InstallLockLostError'
  }
}

/** Going back was asked for, but there is no published previous release. Nothing was written. */
export class NothingToGoBackToError extends Error {
  constructor(
    readonly kind: BuiltinHarnessKind,
    readonly reason: string,
  ) {
    super(`${kind} has nothing to go back to: ${reason}`)
    this.name = 'NothingToGoBackToError'
  }
}

/** The database was written by a newer Podium. It is left untouched. */
export class InstallLedgerTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `${path} was written by a newer version of Podium (ledger schema ${found}; this build reads up to ${INSTALL_LEDGER_SCHEMA_VERSION}). ` +
        'Update Podium on this machine. The file has not been changed.',
    )
    this.name = 'InstallLedgerTooNewError'
  }
}

// ---------------------------------------------------------------------------
// Opening

export interface InstallLedgerOptions {
  /** The folder holding the release folders and `ledger.db`. Default `<state>/harnesses`. */
  harnessesDir?: string
  now?: () => Date
  pid?: number
  hostname?: string
  /** Whether a process on this host is alive. Default: `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean
}

const TABLES = [
  'meta',
  'managed_install',
  'rejected_release',
  'session_install',
  'home_edit',
  'install_lock',
]

type Probe =
  | { kind: 'ok'; db: SqlDatabase }
  | { kind: 'uninitialized'; db: SqlDatabase }
  | { kind: 'damaged'; detail: string; ino: number }

export class InstallLedger {
  readonly path: string
  readonly harnessesDir: string
  private readonly now: () => Date
  private readonly pid: number
  private readonly hostname: string
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly locks = new Set<LeaseHandle>()
  /**
   * Prepared once and finalized on close. A statement left unfinalized turns
   * `close()` into a deferred close that keeps the file's locks, and the other
   * program on this ledger would then wait on a connection nobody uses.
   */
  private readonly statements = new Map<string, SqlStatement>()

  private constructor(
    private readonly db: SqlDatabase,
    options: Required<InstallLedgerOptions>,
  ) {
    this.harnessesDir = options.harnessesDir
    this.path = join(options.harnessesDir, LEDGER_FILE)
    this.now = options.now
    this.pid = options.pid
    this.hostname = options.hostname
    this.isProcessAlive = options.isProcessAlive
  }

  /**
   * Open the ledger, creating it when absent. A missing database with release
   * folders on disk, or a damaged one (set aside first), is rebuilt from the
   * folders. Throws {@link InstallLedgerTooNewError} for a newer schema, and
   * rethrows any error that does not show damage (permissions, a lock held past
   * the busy timeout): a database is set aside only when SQLite says it is not
   * a database or is corrupt.
   */
  static open(options: InstallLedgerOptions = {}): InstallLedger {
    const resolved: Required<InstallLedgerOptions> = {
      harnessesDir: options.harnessesDir ?? defaultHarnessesDir(),
      now: options.now ?? (() => new Date()),
      pid: options.pid ?? process.pid,
      hostname: options.hostname ?? osHostname(),
      isProcessAlive: options.isProcessAlive ?? processAlive,
    }
    mkdirSync(resolved.harnessesDir, { recursive: true })
    const path = join(resolved.harnessesDir, LEDGER_FILE)

    let damage: { setAside?: string; detail: string } | undefined
    let probe = probeLedger(path)
    if (probe.kind === 'damaged') {
      damage = { setAside: setAsideDamaged(path, probe.ino, resolved.now()), detail: probe.detail }
      probe = probeLedger(path)
      if (probe.kind === 'damaged')
        throw new Error(`${path} is still damaged after setting it aside: ${probe.detail}`)
    }
    const ledger = new InstallLedger(probe.db, resolved)
    if (probe.kind === 'uninitialized') ledger.initialize(damage)
    return ledger
  }

  close(): void {
    for (const lock of [...this.locks]) lock.release()
    for (const statement of this.statements.values()) statement.finalize?.()
    this.statements.clear()
    this.db.close()
  }

  private sql(text: string): SqlStatement {
    let statement = this.statements.get(text)
    if (!statement) {
      statement = this.db.prepare(text)
      this.statements.set(text, statement)
    }
    return statement
  }

  // -------------------------------------------------------------------------
  // Managed installs

  get(kind: BuiltinHarnessKind): ManagedInstall | undefined {
    const row = this.sql('SELECT * FROM managed_install WHERE kind = ?').get(kind) as
      | ManagedInstallRow
      | undefined
    return row ? decodeManagedInstall(row) : undefined
  }

  list(): ManagedInstall[] {
    const rows = this.sql(
      'SELECT * FROM managed_install ORDER BY kind',
    ).all() as ManagedInstallRow[]
    return rows.map(decodeManagedInstall)
  }

  /** Start managing a harness. An existing row is kept as it is and returned. */
  requestInstall(kind: BuiltinHarnessKind, by: 'machine-setup' | 'person'): ManagedInstall {
    this.sql(
      `INSERT INTO managed_install (kind, next_number, paused, requested_by, requested_at)
         VALUES (?, 1, 0, ?, ?) ON CONFLICT(kind) DO NOTHING`,
    ).run(kind, by, this.isoNow())
    return this.require(kind)
  }

  /**
   * Drop the row a first install made when that install is cancelled before it
   * publishes, as if it had never been asked for. Holds the install lock. Keeps
   * a row that names a release, is being removed, or that a session names.
   */
  forgetUnpublished(kind: BuiltinHarnessKind, lock: InstallLock): boolean {
    return this.withLock(lock, () => {
      const row = this.get(kind)
      if (
        !row ||
        row.current != null ||
        row.previous != null ||
        row.removingAt ||
        this.sessionInstalls(kind).length > 0
      )
        return false
      this.sql('DELETE FROM managed_install WHERE kind = ?').run(kind)
      return true
    })
  }

  /** Stop selecting this install before deleting any release. Holds the install lock. */
  requestRemoval(kind: BuiltinHarnessKind, lock: InstallLock): void {
    if (!lock.held()) throw new InstallLockLostError()
    this.sql(
      'UPDATE managed_install SET removing_at = COALESCE(removing_at, ?), paused = 1 WHERE kind = ?',
    ).run(this.isoNow(), kind)
  }

  /** Finish only after the release folders have gone and no managed process uses them. */
  finishRemoval(kind: BuiltinHarnessKind, lock: InstallLock): boolean {
    if (!lock.held()) throw new InstallLockLostError()
    return this.writeAtomically(() => {
      if (
        !this.get(kind)?.removingAt ||
        this.sessionInstalls(kind).some((row) => row.provenance === 'managed')
      )
        return false
      this.sql('DELETE FROM rejected_release WHERE kind = ?').run(kind)
      this.sql('DELETE FROM managed_install WHERE kind = ?').run(kind)
      return true
    })
  }

  setPaused(kind: BuiltinHarnessKind, paused: boolean): void {
    this.updateExisting(
      kind,
      'UPDATE managed_install SET paused = ? WHERE kind = ?',
      paused ? 1 : 0,
    )
  }

  /**
   * Record one call to the adapter's `latest()`. A failed check starts the
   * failing run if none is open. A good check that leaves nothing to install
   * ends it; a good check that leads to an install leaves it to the install.
   */
  recordCheck(
    kind: BuiltinHarnessKind,
    outcome: { ok: true; latest: string; nothingToInstall: boolean } | { ok: false; error: string },
  ): void {
    const at = this.isoNow()
    const lastCheck = outcome.ok
      ? { at, ok: true as const, latest: outcome.latest }
      : { at, ok: false as const, error: outcome.error }
    const failingSince = outcome.ok
      ? outcome.nothingToInstall
        ? 'NULL'
        : 'failing_since'
      : 'COALESCE(failing_since, ?)'
    const params = outcome.ok ? [JSON.stringify(lastCheck)] : [JSON.stringify(lastCheck), at]
    this.updateExisting(
      kind,
      `UPDATE managed_install SET last_check = ?, failing_since = ${failingSince} WHERE kind = ?`,
      ...params,
    )
  }

  /** Record a failed install. Starts the failing run if none is open. */
  recordInstallFailure(
    kind: BuiltinHarnessKind,
    failure: { version: string; error: string },
  ): void {
    const at = this.isoNow()
    this.updateExisting(
      kind,
      `UPDATE managed_install SET last_install_error = ?, failing_since = COALESCE(failing_since, ?)
       WHERE kind = ?`,
      JSON.stringify({ at, version: failure.version, error: failure.error }),
      at,
    )
  }

  /**
   * The number for a new release folder, under the install lock. Never a number
   * a folder on disk already has, so a leftover from before a rebuild is never
   * overwritten.
   */
  allocateReleaseNumber(kind: BuiltinHarnessKind, lock: InstallLock): number {
    return this.withLock(lock, () => {
      const row = this.require(kind)
      const onDisk = listReleaseFolders(this.harnessesDir, kind).reduce(
        (max, f) => Math.max(max, f.number),
        0,
      )
      const number = Math.max(row.nextNumber, onDisk + 1)
      this.sql('UPDATE managed_install SET next_number = ? WHERE kind = ?').run(number + 1, kind)
      return number
    })
  }

  /**
   * Publish a release: `number` becomes current and the old current becomes
   * previous, in one transaction, and only while `lock` is held. The folder
   * must already be in place with a valid receipt. Ends the failing run and
   * clears the last install error.
   */
  publishRelease(kind: BuiltinHarnessKind, number: number, lock: InstallLock): ManagedInstall {
    return this.withLock(lock, () => {
      const row = this.require(kind)
      if (number === row.current) throw new Error(`release ${number} of ${kind} is already current`)
      if (number >= row.nextNumber)
        throw new Error(
          `release ${number} of ${kind} was never allocated (next is ${row.nextNumber})`,
        )
      // Current only ever names a folder that is a release: renamed into place with a valid receipt.
      const folder = this.releaseFolder(kind, number)
      if (!folder?.receipt)
        throw new Error(
          `release ${number} of ${kind} is not a published folder: ${folder?.invalid ?? 'no such folder'}`,
        )
      this.sql(
        `UPDATE managed_install
           SET previous = current, current = ?, vendor_updated = ?, failing_since = NULL, last_install_error = NULL
           WHERE kind = ?`,
      ).run(number, folder.receipt.updater === 'cannot-stop' ? 1 : 0, kind)
      return this.require(kind)
    })
  }

  /**
   * A person goes back (§5.6): the previous release becomes current, and the
   * version that was current goes on the rejected list so no check brings it
   * straight back. One transaction, only while `lock` is held, and only when
   * the previous folder is still a published release. Nothing is left to go
   * back to afterwards (`previous` is cleared); housekeeping deletes the
   * rejected folder once no session runs on it.
   *
   * With {@link publishRelease}, the only write that moves `current`.
   */
  revertToPrevious(
    kind: BuiltinHarnessKind,
    lock: InstallLock,
    reason: string,
  ): { row: ManagedInstall; rejected?: string } {
    return this.withLock(lock, () => {
      const row = this.require(kind)
      if (row.previous == null)
        throw new NothingToGoBackToError(kind, 'there is no previous release')
      const previous = this.releaseFolder(kind, row.previous)
      if (!previous?.receipt)
        throw new NothingToGoBackToError(
          kind,
          `release ${row.previous} is not a published folder: ${previous?.invalid ?? 'no such folder'}`,
        )
      const current = row.current == null ? undefined : this.releaseFolder(kind, row.current)
      const rejected = current?.receipt?.version ?? current?.version
      if (rejected !== undefined && rejected !== previous.receipt.version)
        this.sql(
          `INSERT INTO rejected_release (kind, version, reason, at) VALUES (?, ?, ?, ?)
             ON CONFLICT(kind, version) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
        ).run(kind, rejected, reason, this.isoNow())
      this.sql(
        'UPDATE managed_install SET current = previous, previous = NULL, vendor_updated = ? WHERE kind = ?',
      ).run(previous.receipt.updater === 'cannot-stop' ? 1 : 0, kind)
      return {
        row: this.require(kind),
        ...(rejected !== undefined && rejected !== previous.receipt.version ? { rejected } : {}),
      }
    })
  }

  /** The current release's folder and receipt, when there is one on disk. */
  currentRelease(kind: BuiltinHarnessKind): ReleaseFolder | undefined {
    const current = this.get(kind)?.current
    return current == null ? undefined : this.releaseFolder(kind, current)
  }

  /** One release folder by number, read from disk. */
  releaseFolder(kind: BuiltinHarnessKind, number: number): ReleaseFolder | undefined {
    return listReleaseFolders(this.harnessesDir, kind).find((folder) => folder.number === number)
  }

  // -------------------------------------------------------------------------
  // Rejected releases

  rejectRelease(kind: BuiltinHarnessKind, version: string, reason: string): void {
    this.sql(
      `INSERT INTO rejected_release (kind, version, reason, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, version) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
    ).run(kind, version, reason, this.isoNow())
  }

  isRejected(kind: BuiltinHarnessKind, version: string): boolean {
    return (
      this.sql('SELECT 1 AS hit FROM rejected_release WHERE kind = ? AND version = ?').get(
        kind,
        version,
      ) !== undefined
    )
  }

  rejectedReleases(kind?: BuiltinHarnessKind): RejectedRelease[] {
    const rows = (
      kind
        ? this.sql('SELECT * FROM rejected_release WHERE kind = ? ORDER BY at, version').all(kind)
        : this.sql('SELECT * FROM rejected_release ORDER BY kind, at, version').all()
    ) as RejectedRelease[]
    return rows.map((row) => ({
      kind: row.kind,
      version: row.version,
      reason: row.reason,
      at: row.at,
    }))
  }

  // -------------------------------------------------------------------------
  // Session installs

  recordSessionInstall(row: SessionInstall): void {
    this.writeAtomically(() => {
      const managed = row.provenance === 'managed' ? this.get(row.kind) : undefined
      if (row.provenance === 'managed' && (!managed || managed.removingAt))
        throw new Error(
          `Podium's install of ${row.kind} is being removed; start again after removal.`,
        )
      this.sql(
        `INSERT INTO session_install (session_id, kind, executable, version, provenance, release)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind, executable = excluded.executable,
           version = excluded.version, provenance = excluded.provenance, release = excluded.release`,
      ).run(row.sessionId, row.kind, row.executable, row.version, row.provenance, row.release)
    })
  }

  removeSessionInstall(sessionId: SessionId): void {
    this.sql('DELETE FROM session_install WHERE session_id = ?').run(sessionId)
  }

  /**
   * Drop every session row not in `live`: the sessions whose harness process
   * still runs. Returns the dropped session ids. One statement, so the set
   * difference is computed by SQLite rather than by listing rows here.
   */
  retainSessionInstalls(live: Iterable<SessionId>): SessionId[] {
    const ids = JSON.stringify([...new Set(live)])
    const rows = this.sql(
      `DELETE FROM session_install
       WHERE session_id NOT IN (SELECT value FROM json_each(?))
       RETURNING session_id`,
    ).all(ids) as { session_id: string }[]
    return rows.map((row) => row.session_id as SessionId).sort()
  }

  sessionInstall(sessionId: SessionId): SessionInstall | undefined {
    const row = this.sql('SELECT * FROM session_install WHERE session_id = ?').get(sessionId) as
      | SessionInstallRow
      | undefined
    return row ? decodeSessionInstall(row) : undefined
  }

  sessionInstalls(kind?: BuiltinHarnessKind): SessionInstall[] {
    const rows = (
      kind
        ? this.sql('SELECT * FROM session_install WHERE kind = ? ORDER BY session_id').all(kind)
        : this.sql('SELECT * FROM session_install ORDER BY session_id').all()
    ) as SessionInstallRow[]
    return rows.map(decodeSessionInstall)
  }

  // -------------------------------------------------------------------------
  // Home edits

  /**
   * Record an edit Podium made. One row per harness, file and edit target (the
   * JSON key path, the TOML array entry, or the owned file). Recording the same
   * target again updates what was written and keeps the original `prior`: what
   * was there before Podium's FIRST write.
   */
  recordHomeEdit(record: HomeEditRecord): StoredHomeEdit {
    const row = this.sql(
      `INSERT INTO home_edit (harness, file, edit_key, edit, prior, serves, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(harness, file, edit_key) DO UPDATE SET edit = excluded.edit, serves = excluded.serves,
           applied_at = excluded.applied_at
         RETURNING *`,
    ).get(
      record.harness,
      record.file,
      homeEditKey(record.edit),
      JSON.stringify(record.edit),
      JSON.stringify(record.prior),
      record.serves,
      record.appliedAt,
    ) as HomeEditRow
    return decodeHomeEdit(row)
  }

  homeEdits(harness?: BuiltinHarnessKind): StoredHomeEdit[] {
    const rows = (
      harness
        ? this.sql('SELECT * FROM home_edit WHERE harness = ? ORDER BY id').all(harness)
        : this.sql('SELECT * FROM home_edit ORDER BY id').all()
    ) as HomeEditRow[]
    return rows.map(decodeHomeEdit)
  }

  removeHomeEdit(id: number): void {
    this.sql('DELETE FROM home_edit WHERE id = ?').run(id)
  }

  // -------------------------------------------------------------------------
  // Rebuild flag

  /** Set when the ledger was rebuilt from the release folders, until {@link clearRebuilt}. */
  rebuilt(): LedgerRebuild | undefined {
    const row = this.sql("SELECT value FROM meta WHERE key = 'rebuilt'").get() as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as LedgerRebuild) : undefined
  }

  /** The machine has reported the rebuild. */
  clearRebuilt(): void {
    this.sql("DELETE FROM meta WHERE key = 'rebuilt'").run()
  }

  // -------------------------------------------------------------------------
  // Install lock

  /**
   * Try to take the install lock. Never waits: a caller that wants to wait
   * retries. A lease that ran out, or whose owner process on this host is gone,
   * is taken over.
   */
  acquireInstallLock(options: AcquireInstallLockOptions): AcquireInstallLockResult {
    const leaseMs = options.leaseMs ?? DEFAULT_INSTALL_LEASE_MS
    const token = randomUUID()
    const nowMs = this.now().getTime()
    const holder: InstallLockHolder = {
      pid: this.pid,
      hostname: this.hostname,
      label: options.label,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAtMs: nowMs + leaseMs,
    }
    const outcome = this.writeAtomically(() => {
      const existing = this.lockRow()
      let tookOver: { from: InstallLockHolder; because: 'expired' | 'owner-gone' } | undefined
      if (existing) {
        const from = decodeHolder(existing)
        if (existing.expires_at_ms <= nowMs) tookOver = { from, because: 'expired' }
        else if (existing.hostname === this.hostname && !this.isProcessAlive(existing.pid))
          tookOver = { from, because: 'owner-gone' }
        else return { acquired: false as const, holder: from }
      }
      this.sql(
        `INSERT INTO install_lock (id, token, pid, hostname, label, acquired_at, expires_at_ms)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET token = excluded.token, pid = excluded.pid,
             hostname = excluded.hostname, label = excluded.label, acquired_at = excluded.acquired_at,
             expires_at_ms = excluded.expires_at_ms`,
      ).run(token, holder.pid, holder.hostname, holder.label, holder.acquiredAt, holder.expiresAtMs)
      return { acquired: true as const, tookOver }
    })
    if (!outcome.acquired) return outcome
    const lock = new LeaseHandle(this, token, holder, leaseMs, options.autoRenew ?? true)
    this.locks.add(lock)
    return outcome.tookOver
      ? { acquired: true, lock, tookOver: outcome.tookOver }
      : { acquired: true, lock }
  }

  /** Who holds the install lock now, if anyone holds an unexpired lease. */
  installLockHolder(): InstallLockHolder | undefined {
    const row = this.lockRow()
    if (!row || row.expires_at_ms <= this.now().getTime()) return undefined
    return decodeHolder(row)
  }

  /** @internal LeaseHandle */
  renewLease(token: string, leaseMs: number): number | undefined {
    const nowMs = this.now().getTime()
    const expires = nowMs + leaseMs
    const result = this.sql(
      'UPDATE install_lock SET expires_at_ms = ? WHERE id = 1 AND token = ? AND expires_at_ms > ?',
    ).run(expires, token, nowMs)
    return Number(result.changes) === 1 ? expires : undefined
  }

  /** @internal LeaseHandle */
  leaseHeld(token: string): boolean {
    const row = this.lockRow()
    return row?.token === token && row.expires_at_ms > this.now().getTime()
  }

  /** @internal LeaseHandle */
  releaseLease(handle: LeaseHandle): void {
    this.locks.delete(handle)
    this.sql('DELETE FROM install_lock WHERE id = 1 AND token = ?').run(handle.token)
  }

  // -------------------------------------------------------------------------
  // Internals

  private lockRow(): LockRow | undefined {
    return this.sql('SELECT * FROM install_lock WHERE id = 1').get() as LockRow | undefined
  }

  /** Run `body` in one write transaction that first proves `lock` still holds. */
  private withLock<T>(lock: InstallLock, body: () => T): T {
    return this.writeAtomically(() => {
      if (!this.leaseHeld(lock.token)) throw new InstallLockLostError()
      return body()
    })
  }

  private writeAtomically<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private require(kind: BuiltinHarnessKind): ManagedInstall {
    const row = this.get(kind)
    if (!row) throw new Error(`${kind} is not a managed install on this machine`)
    return row
  }

  private updateExisting(
    kind: BuiltinHarnessKind,
    sql: string,
    ...params: (string | number)[]
  ): void {
    const result = this.sql(sql).run(...params, kind)
    if (Number(result.changes) === 0)
      throw new Error(`${kind} is not a managed install on this machine`)
  }

  private isoNow(): string {
    return this.now().toISOString()
  }

  /**
   * Create the schema in one write transaction and, when release folders exist,
   * rebuild the managed-install rows from them. Another process may have
   * initialized the file meanwhile (the daemon and the CLI opening a missing
   * ledger together); then this does nothing.
   */
  private initialize(damage: { setAside?: string; detail: string } | undefined): void {
    this.writeAtomically(() => {
      const hasMeta = this.sql(
        "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      ).get()
      if (hasMeta) return
      this.db.exec(SCHEMA)
      this.sql("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(INSTALL_LEDGER_SCHEMA_VERSION),
      )
      const { restored, sawFolders } = this.rebuildFromFolders()
      if (damage || sawFolders) {
        const rebuild: LedgerRebuild = {
          at: this.isoNow(),
          reason: damage ? 'damaged' : 'missing',
          ...(damage?.setAside ? { setAside: damage.setAside } : {}),
          ...(damage ? { detail: damage.detail } : {}),
          restored,
        }
        this.sql("INSERT INTO meta (key, value) VALUES ('rebuilt', ?)").run(JSON.stringify(rebuild))
      }
    })
  }

  private rebuildFromFolders(): { restored: BuiltinHarnessKind[]; sawFolders: boolean } {
    const restored: BuiltinHarnessKind[] = []
    let sawFolders = false
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const folders = listReleaseFolders(this.harnessesDir, kind)
      if (folders.length === 0) continue
      sawFolders = true
      const releases = folders.filter(
        (folder): folder is ReleaseFolder & { receipt: InstallReceipt } => Boolean(folder.receipt),
      )
      const [current, previous] = releases
      if (!current) continue
      const nextNumber = (folders[0]?.number ?? 0) + 1
      this.sql(
        `INSERT INTO managed_install (kind, next_number, current, previous, paused, vendor_updated, requested_by, requested_at)
           VALUES (?, ?, ?, ?, 0, ?, 'ledger-rebuild', ?)`,
      ).run(
        kind,
        nextNumber,
        current.number,
        previous?.number ?? null,
        current.receipt.updater === 'cannot-stop' ? 1 : 0,
        current.receipt.installedAt,
      )
      restored.push(kind)
    }
    return { restored, sawFolders }
  }
}

/** One lease on the install lock, renewed on a timer while held. */
class LeaseHandle implements InstallLock {
  private timer: ReturnType<typeof setInterval> | undefined
  private released = false
  private lost = false
  private expiresAtMs: number

  constructor(
    private readonly ledger: InstallLedger,
    readonly token: string,
    private readonly owner: InstallLockHolder,
    private readonly leaseMs: number,
    autoRenew: boolean,
  ) {
    this.expiresAtMs = owner.expiresAtMs
    if (autoRenew) {
      this.timer = setInterval(() => this.renew(), Math.max(1, Math.floor(leaseMs / 3)))
      this.timer.unref?.()
    }
  }

  get holder(): InstallLockHolder {
    return { ...this.owner, expiresAtMs: this.expiresAtMs }
  }

  renew(): boolean {
    if (this.released || this.lost) return false
    const expires = this.ledger.renewLease(this.token, this.leaseMs)
    if (expires === undefined) {
      this.lost = true
      this.stopTimer()
      return false
    }
    this.expiresAtMs = expires
    return true
  }

  held(): boolean {
    if (this.released || this.lost) return false
    return this.ledger.leaseHeld(this.token)
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.stopTimer()
    this.ledger.releaseLease(this)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

// ---------------------------------------------------------------------------
// Schema and row codecs

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE managed_install (
    kind TEXT PRIMARY KEY,
    next_number INTEGER NOT NULL,
    current INTEGER,
    previous INTEGER,
    paused INTEGER NOT NULL DEFAULT 0,
    vendor_updated INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    last_check TEXT,
    last_install_error TEXT,
    failing_since TEXT,
    removing_at TEXT
  );
  CREATE TABLE rejected_release (
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    reason TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (kind, version)
  );
  CREATE TABLE session_install (
    session_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    executable TEXT NOT NULL,
    version TEXT NOT NULL,
    provenance TEXT NOT NULL,
    release INTEGER
  );
  CREATE TABLE home_edit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    harness TEXT NOT NULL,
    file TEXT NOT NULL,
    edit_key TEXT NOT NULL,
    edit TEXT NOT NULL,
    prior TEXT NOT NULL,
    serves TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    UNIQUE (harness, file, edit_key)
  );
  CREATE TABLE install_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    label TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );
`

interface ManagedInstallRow {
  kind: BuiltinHarnessKind
  next_number: number
  current: number | null
  previous: number | null
  paused: number
  vendor_updated: number
  requested_by: ManagedInstall['requested']['by']
  requested_at: string
  last_check: string | null
  last_install_error: string | null
  failing_since: string | null
  removing_at: string | null
}

function decodeManagedInstall(row: ManagedInstallRow): ManagedInstall {
  return {
    kind: row.kind,
    nextNumber: row.next_number,
    ...(row.removing_at ? { removingAt: row.removing_at } : {}),
    current: row.current,
    previous: row.previous,
    paused: row.paused !== 0,
    vendorUpdated: row.vendor_updated !== 0,
    requested: { by: row.requested_by, at: row.requested_at },
    ...(row.last_check ? { lastCheck: JSON.parse(row.last_check) } : {}),
    ...(row.last_install_error ? { lastInstallError: JSON.parse(row.last_install_error) } : {}),
    ...(row.failing_since ? { failingSince: row.failing_since } : {}),
  }
}

interface SessionInstallRow {
  session_id: string
  kind: BuiltinHarnessKind
  executable: string
  version: string
  provenance: SessionInstall['provenance']
  release: number | null
}

function decodeSessionInstall(row: SessionInstallRow): SessionInstall {
  return {
    sessionId: row.session_id as SessionId,
    kind: row.kind,
    executable: row.executable,
    version: row.version,
    provenance: row.provenance,
    release: row.release,
  }
}

interface HomeEditRow {
  id: number
  harness: BuiltinHarnessKind
  file: string
  edit: string
  prior: string
  serves: HomeEditServes
  applied_at: string
}

function decodeHomeEdit(row: HomeEditRow): StoredHomeEdit {
  return {
    id: row.id,
    harness: row.harness,
    file: row.file,
    edit: JSON.parse(row.edit),
    prior: JSON.parse(row.prior),
    serves: row.serves,
    appliedAt: row.applied_at,
  }
}

/** What one edit targets, so a second write to it is the same row. */
function homeEditKey(edit: HomeEditRecord['edit']): string {
  switch (edit.kind) {
    case 'json-key':
      return JSON.stringify(['json-key', edit.path])
    case 'toml-array-entry':
      return JSON.stringify(['toml-array-entry', edit.path, edit.value])
    case 'owned-file':
      return JSON.stringify(['owned-file'])
    case 'hook-handlers':
      return JSON.stringify(['hook-handlers', edit.marker])
  }
}

interface LockRow {
  token: string
  pid: number
  hostname: string
  label: string
  acquired_at: string
  expires_at_ms: number
}

function decodeHolder(row: LockRow): InstallLockHolder {
  return {
    pid: row.pid,
    hostname: row.hostname,
    label: row.label,
    acquiredAt: row.acquired_at,
    expiresAtMs: row.expires_at_ms,
  }
}

// ---------------------------------------------------------------------------
// Opening, damage and setting aside

/** Run one read and finalize its statement, so a later close really closes. */
function queryOnce(db: SqlDatabase, sql: string): unknown[] {
  const statement = db.prepare(sql)
  try {
    return statement.all()
  } finally {
    statement.finalize?.()
  }
}

function sqliteCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code ?? '')
}

function showsDamage(error: unknown): boolean {
  const code = sqliteCode(error)
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT')
}

/**
 * Open `path` and classify it. Damage is only what SQLite reports as not a
 * database or corrupt, a failed `quick_check`, or a ledger with its version
 * row or tables missing. Every other error is rethrown untouched.
 */
function probeLedger(path: string): Probe {
  const existed = existsSync(path)
  if (!existed) moveOrphanSidecars(path)
  const ino = existed ? statSync(path).ino : 0
  const db = openDatabase(path)
  try {
    // Nothing is written before the version is known: a newer ledger is left as it is.
    db.exec('PRAGMA busy_timeout = 5000')
    const check = queryOnce(db, 'PRAGMA quick_check') as { quick_check: string }[]
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') {
      db.close()
      return {
        kind: 'damaged',
        detail: `quick_check: ${check.map((r) => r.quick_check).join('; ')}`,
        ino,
      }
    }
    const tables = new Set(
      (
        queryOnce(db, "SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]
      ).map((row) => row.name),
    )
    if (!tables.has('meta')) {
      const ours = TABLES.filter((name) => tables.has(name))
      if (ours.length > 0) {
        db.close()
        return { kind: 'damaged', detail: `meta table missing beside ${ours.join(', ')}`, ino }
      }
      db.exec('PRAGMA journal_mode = WAL')
      return { kind: 'uninitialized', db }
    }
    const version = queryOnce(db, "SELECT value FROM meta WHERE key = 'schema_version'")[0] as
      | { value: string }
      | undefined
    const found = version ? Number(version.value) : Number.NaN
    if (!Number.isSafeInteger(found) || found < 1) {
      db.close()
      return {
        kind: 'damaged',
        detail: `schema version unreadable: ${version?.value ?? 'missing'}`,
        ino,
      }
    }
    if (found > INSTALL_LEDGER_SCHEMA_VERSION) {
      db.close()
      throw new InstallLedgerTooNewError(path, found)
    }
    const missing = TABLES.filter((name) => !tables.has(name))
    if (missing.length > 0) {
      db.close()
      return { kind: 'damaged', detail: `tables missing: ${missing.join(', ')}`, ino }
    }
    if (found < INSTALL_LEDGER_SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE')
      try {
        // Re-read under the writer lock: the CLI and daemon can open together.
        const columns = queryOnce(db, 'PRAGMA table_info(managed_install)') as { name: string }[]
        if (!columns.some((column) => column.name === 'removing_at'))
          db.exec('ALTER TABLE managed_install ADD COLUMN removing_at TEXT')
        if (!columns.some((column) => column.name === 'vendor_updated'))
          db.exec(
            'ALTER TABLE managed_install ADD COLUMN vendor_updated INTEGER NOT NULL DEFAULT 0',
          )
        db.exec(
          `UPDATE meta SET value = '${INSTALL_LEDGER_SCHEMA_VERSION}' WHERE key = 'schema_version'`,
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    db.exec('PRAGMA journal_mode = WAL')
    return { kind: 'ok', db }
  } catch (error) {
    try {
      db.close()
    } catch {}
    if (showsDamage(error)) return { kind: 'damaged', detail: (error as Error).message, ino }
    throw error
  }
}

const SIDECARS = ['-wal', '-shm', '-journal']

/**
 * Rename a damaged ledger (and its WAL, shared-memory and journal files, which
 * belong to it and would be replayed into a new file) to
 * `ledger.db.damaged-<time>`. Skipped when the path no longer holds the file
 * that was found damaged: another process has set it aside already.
 */
function setAsideDamaged(path: string, ino: number, now: Date): string | undefined {
  try {
    if (statSync(path).ino !== ino) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const target = `${path}.damaged-${now.toISOString().replace(/[:.]/g, '-')}`
  renameSync(path, target)
  for (const suffix of SIDECARS) renameIfPresent(`${path}${suffix}`, `${target}${suffix}`)
  return target
}

/** A WAL or journal with no database beside it would be replayed into a new file. */
function moveOrphanSidecars(path: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const suffix of SIDECARS) {
    if (existsSync(path)) return
    renameIfPresent(`${path}${suffix}`, `${path}.orphan-${stamp}${suffix}`)
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
