/**
 * Does this process still hold its SQLite locks on a live database? [POD-6263]
 *
 * POSIX advisory locks belong to the PROCESS, and closing ANY descriptor on a
 * file releases every lock the process holds on it. A plain `copyFileSync` of a
 * database this process has open therefore drops the SHARED lock SQLite keeps on
 * the database file and the shared lock on the `-shm` deadman-switch byte that
 * tells other processes the wal-index is in use
 * (https://sqlite.org/howtocorrupt.html §2.2). SQLite never notices. The next
 * process to open the database then believes it is the only connection: it
 * truncates and rebuilds the `-shm` under the live process's mapping (the
 * production SIGBUS), and when it closes it checkpoints and DELETES the `-wal`
 * and `-shm` the live process is still using.
 *
 * The probes, used together by the tests that guard every snapshot path:
 * {@link posixLocksOn} reads the locks straight from `/proc/locks` (Linux);
 * {@link exclusiveLockFromAnotherProcess} shows the database SHARED lock from
 * another process on every platform (it must be refused); and
 * {@link openFromAnotherProcess} does what any other program would do, after
 * which both sidecars must still exist (the deadman switch held).
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** The `-shm` byte whose shared lock means "the wal-index is in use" (UNIX_SHM_DMS). */
export const SHM_DEADMAN_SWITCH_BYTE = 128

export interface HeldLock {
  type: string
  start: number
  /** Inclusive; `null` for a lock that runs to end of file. */
  end: number | null
}

/**
 * The POSIX locks process `pid` holds on `path`, from `/proc/locks`.
 * `undefined` off Linux, where there is no such table to read.
 */
export function posixLocksOn(path: string, pid: number = process.pid): HeldLock[] | undefined {
  if (process.platform !== 'linux') return undefined
  const inode = String(statSync(path).ino)
  return readFileSync('/proc/locks', 'utf8')
    .split('\n')
    .flatMap((line) => {
      // `1: POSIX  ADVISORY  READ 802784 fd:01:1234567 128 128`; waiters carry `->`.
      const field = line.trim().split(/\s+/)
      if (field[1] !== 'POSIX' || Number(field[4]) !== pid) return []
      if (field[5]?.split(':')[2] !== inode) return []
      return [
        {
          type: field[3] ?? '',
          start: Number(field[6]),
          end: field[7] === 'EOF' ? null : Number(field[7]),
        },
      ]
    })
}

/** True when `locks` include a read lock covering `byte`. */
export function readLockCovers(locks: readonly HeldLock[], byte: number): boolean {
  return locks.some(
    (lock) => lock.type === 'READ' && lock.start <= byte && (lock.end === null || byte <= lock.end),
  )
}

function runProbe(dbPath: string, lines: readonly string[]): string {
  const script = [
    "const { Database } = require('bun:sqlite')",
    'const db = new Database(process.env.PODIUM_LOCK_PROBE_DB)',
    ...lines,
  ].join('\n')
  const probe = spawnSync(process.execPath, ['-e', script], {
    cwd: tmpdir(),
    env: { ...process.env, PODIUM_LOCK_PROBE_DB: dbPath },
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (probe.status !== 0) {
    throw new Error(
      `the probe process failed: status=${probe.status} signal=${probe.signal} ${probe.stderr}`,
    )
  }
  return probe.stdout.trim()
}

/**
 * Open `dbPath` from a separate process, read it, and close it, the way any
 * other program (a second Podium process, `sqlite3`, a diagnostic) would.
 * Probes the wal-index deadman switch: a process that finds it unlocked
 * truncates the `-shm`, and deletes both sidecars when it closes.
 */
export function openFromAnotherProcess(dbPath: string): void {
  runProbe(dbPath, ["db.query('SELECT count(*) AS n FROM sqlite_schema').get()", 'db.close()'])
}

/**
 * Ask for an EXCLUSIVE lock on `dbPath` from a separate process, without
 * waiting. A connection in exclusive locking mode takes it on its first read of
 * a WAL database; any process holding the database SHARED lock refuses it.
 * `granted` therefore means the live process no longer holds that lock, and
 * anything taking it next (leaving WAL mode, an exclusive writer) proceeds as
 * if the database were idle. Closing after a grant may checkpoint and delete
 * the `-wal`.
 */
export function exclusiveLockFromAnotherProcess(dbPath: string): 'granted' | 'refused' {
  const verdict = runProbe(dbPath, [
    "db.exec('PRAGMA busy_timeout = 0')",
    "db.exec('PRAGMA locking_mode = EXCLUSIVE')",
    'let verdict',
    "try { db.query('SELECT count(*) AS n FROM sqlite_schema').get(); verdict = 'granted' }",
    "catch (error) { verdict = /locked|busy/i.test(String(error)) ? 'refused' : 'error: ' + error }",
    'db.close()',
    'process.stdout.write(verdict)',
  ])
  if (verdict !== 'granted' && verdict !== 'refused') {
    throw new Error(`the exclusive-lock probe answered ${verdict}`)
  }
  return verdict
}
