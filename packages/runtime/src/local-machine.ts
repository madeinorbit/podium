import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './config'

export { stateDir }

/**
 * THE HOST MACHINE'S OWN IDENTITY — read once, or minted once, from the state dir.
 *
 * ONE SCHEME FOR EVERY MACHINE (POD-318). A remote daemon already mints a UUID into
 * `~/.podium/daemon.json` (`apps/daemon/src/identity.ts`); the host the server runs on
 * now does exactly the same thing, into `<stateDir>/machine.id`. The `'local'` constant
 * and the `'__local__'` placeholder that used to stand in for this file are gone: a
 * machine id is minted material or it is nothing.
 *
 * WHY A FILE AND NOT A ROW. The server must know its own machine id BEFORE it writes the
 * first row — otherwise rows are created machine-less and something has to adopt them
 * afterwards, which is the entire class of bug this replaces. The state dir is the one
 * thing that exists before the database does.
 *
 * WHY THE SAME FILE SERVES THE SPLIT-MODE DAEMON. `podium-server` and `podium-daemon` are
 * two processes on ONE host sharing ONE state dir, so the local daemon reads this same
 * file and presents this same id in its ordinary `hello`, credentialed by the loopback
 * bootstrap secret ({@link readOrCreateDaemonSecret}) — the same handshake a remote uses,
 * with no bootstrap special case. All-in-one passes the value in-memory instead, but it
 * is the same value, read from the same file by the same process.
 *
 * Race-safe by the same `wx` trick as the secret: whichever process creates it wins and
 * the loser re-reads the winner's id, so a simultaneous server+daemon cold start cannot
 * leave one host wearing two identities. Owner-only (0600) to match its neighbour; the id
 * is durable identity, not a secret, and nothing is authorized by holding it.
 */
export function readOrCreateLocalMachineId(dir: string = stateDir()): string {
  const path = join(dir, 'machine.id')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    // not minted yet — fall through and mint it
  }
  const id = randomUUID()
  mkdirSync(dir, { recursive: true })
  try {
    // `wx`: fail if the file already exists, so a server/daemon startup race can't have
    // one clobber the other's identity — the loser re-reads the winner's value.
    writeFileSync(path, id, { mode: 0o600, flag: 'wx' })
    return id
  } catch {
    return readFileSync(path, 'utf8').trim()
  }
}

/**
 * Read (or create-once) the persistent shared secret that the **local, same-host
 * daemon** presents to authenticate without pairing.
 *
 * The original bootstrap token lived only in the server process and was handed to the
 * in-process daemon via the ServerHandle. When the backend is split into separate
 * `podium-server` and `podium-daemon` services, the daemon is a different process and
 * can't see that token — so it could never authenticate, no machine ever registered,
 * and every existing session/repo row on this host was stranded and invisible.
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
 * This is a recoverable availability blip, NOT data-loss — the host machine's row and
 * every row attributed to it are written under the id in `machine.id`, which this file
 * has no say over (see {@link readOrCreateLocalMachineId}), and the durable abduco
 * masters survive, so sessions/repos stay attributed and the PTYs reattach once the
 * daemon is restarted with the current secret.
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
