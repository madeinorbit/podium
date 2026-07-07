import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The Podium state directory: $PODIUM_STATE_DIR, else ~/.podium. Mirrors the store's
 *  `defaultDbPath` base so the daemon secret lives next to podium.db. */
export function stateDir(): string {
  return process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
}

/**
 * Stable id of THE local machine — the host the server runs on. The server adopts every
 * pre-existing `'__local__'` row onto it at startup (so the data is attributed by the
 * SERVER, never dependent on the local daemon authenticating), and the bundled local
 * daemon presents this id so it attaches to the same machine. A constant (one local
 * machine per server) — remote daemons use their own UUID + pairing.
 */
export const LOCAL_MACHINE_ID = 'local'

/** Placeholder machineId for sessions/rows created before a real machine adopts
 *  them (single-machine boot, pre-provisioning). `ensureLocalMachine` rewrites these. */
export const LOCAL_PLACEHOLDER = '__local__'

/**
 * Read (or create-once) the persistent shared secret that the **local, same-host
 * daemon** presents to authenticate without pairing.
 *
 * The original bootstrap token lived only in the server process and was handed to the
 * in-process daemon via the ServerHandle. When the backend is split into separate
 * `podium-server` and `podium-daemon` services, the daemon is a different process and
 * can't see that token — so it could never authenticate, no machine ever registered,
 * and every existing `machine_id='__local__'` session/repo was stranded and invisible.
 *
 * Both processes share one host and one state dir, so a secret file there is the seam:
 * the server reads it to trust the local daemon, the daemon reads it to present. It is
 * persistent (not per-boot) so there's no startup-ordering race — whichever process
 * starts first creates it, the other reads the same value. Owner-only (0600).
 *
 * Operational note: don't delete this file out from under a running split daemon. The
 * secret is captured once at daemon start; if the file is deleted and the server then
 * restarts, the server regenerates a new secret while the daemon still presents the old
 * one, so the local daemon's `hello` is rejected on every reconnect until it's restarted.
 * This is a recoverable availability blip, NOT data-loss — the server adopts the local
 * rows at startup independent of the daemon (see `ensureLocalMachine`), and the durable
 * abduco masters survive, so sessions/repos stay attributed and the PTYs reattach once
 * the daemon is restarted with the current secret.
 */
export function readOrCreateDaemonSecret(dir: string = stateDir()): string {
  const path = join(dir, 'daemon.secret')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    // not created yet — fall through and create it
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dir, { recursive: true })
  try {
    // `wx`: fail if the file already exists, so a server/daemon startup race can't have
    // one clobber the other's secret — the loser re-reads the winner's value.
    writeFileSync(path, secret, { mode: 0o600, flag: 'wx' })
    return secret
  } catch {
    return readFileSync(path, 'utf8').trim()
  }
}
