/**
 * WHERE AN ABDUCO MASTER'S SOCKET LANDS, AND WHETHER IT FITS [spec:SP-0be7].
 *
 * A durable session IS a unix socket, and a unix socket path has a hard kernel
 * ceiling: `sizeof(struct sockaddr_un.sun_path)` is 108 bytes on Linux. abduco
 * builds `<root>/abduco/<user>/<label>@<host>` and refuses the whole create
 * when that exceeds the ceiling — with a one-line "create-session: File name
 * too long" that names neither the path nor the limit (POD-2853).
 *
 * THE BUDGET IS NOT NEGOTIABLE AND THE LABEL EATS MOST OF IT. A named
 * instance's durable label is `podium-<instance>-<uuid>`: 44 bytes plus the
 * instance id before anything else is spent. Add `@<hostname>` and abduco's own
 * `abduco/<user>/` and roughly two thirds of the 108 are gone, which leaves the
 * SOCKET ROOT about 33 bytes on a typical host. `$HOME/.local/state/podium/<id>`
 * — the state root docs/multi-instance.md documents for a named instance — is
 * 35 bytes on its own. That is why the state directory can never be the socket
 * root for a named instance, and why de-duplicating the old
 * `<state>/runtime/abduco` pin was not enough on its own: measured on a real
 * instance it moved the composed path from 121 bytes to 114, against 108.
 *
 * So the root comes from the RUNTIME directory, which is what XDG_RUNTIME_DIR
 * is for and is already a dependency of durable sessions (the systemd user
 * scope that keeps a master alive across a redeploy lives in the same user
 * manager). Sockets are runtime state, not durable state; a state root that
 * outlives a login has no business holding them.
 */

import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * `sizeof(struct sockaddr_un.sun_path)` on Linux, which is the ceiling abduco
 * measures against in `set_socket_name` — `dirlen + label + host >= maxlen`
 * is ENAMETOOLONG. macOS is 104, so the Linux number is not a safe upper bound
 * everywhere; it is the one that matters for the durable backend, which is
 * Linux-only in practice (abduco needs forkpty and the scope needs systemd).
 */
export const ABDUCO_SUN_PATH_MAX = 108

/**
 * The directory abduco binds in under `root`, WITH the trailing slash abduco
 * itself leaves in `sun_path`. Not `join`-and-forget: the trailing slash is a
 * real byte and leaving it out understates the composed length by one, which is
 * exactly the kind of off-by-one that turns a fits-check into a lie.
 *
 * Mirrors `create_socket_dir` for a NON-personal root (`ABDUCO_SOCKET_DIR`,
 * `TMPDIR`, `/tmp`): `<root>/abduco/` then a per-user subdirectory. The
 * personal root (`HOME`) takes `<home>/.abduco/` and no user subdirectory —
 * see {@link abducoHomeSocketDir}.
 */
export function abducoSocketDir(root: string, username: string): string {
  return `${join(root, 'abduco', username)}/`
}

/** abduco's personal root: `$HOME/.abduco/`, with no per-user subdirectory. */
export function abducoHomeSocketDir(home: string): string {
  return `${join(home, '.abduco')}/`
}

/**
 * Bytes abduco needs for a session under `dir` — the exact quantity its own
 * ENAMETOOLONG check measures, so a caller can report the number instead of
 * relaying a message that omits it.
 */
export function abducoSocketPathBytes(dir: string, label: string, host: string): number {
  return (
    Buffer.byteLength(dir, 'utf8') +
    Buffer.byteLength(label, 'utf8') +
    Buffer.byteLength(host, 'utf8')
  )
}

/** Whether a session under `dir` fits. abduco refuses at `>=`, not `>`. */
export function abducoSocketPathFits(dir: string, label: string, host: string): boolean {
  return abducoSocketPathBytes(dir, label, host) < ABDUCO_SUN_PATH_MAX
}

/**
 * Widest slot a harness may claim in a client-terminal label.
 *
 * `packages/harness` declares these (`labelToken`) and cannot be imported from
 * here — the dependency runs the other way — so the budget reserves a width and
 * a test on the harness side derives the real tokens from the manifests and
 * fails if any outgrows it. Two is what all three declare today ('oc', 'gk',
 * 'cx') and the manifest calls them "short on purpose".
 */
export const CLIENT_TERMINAL_LABEL_TOKEN_MAX = 2

/**
 * The LONGEST durable label this instance can mint, which is what a root has to
 * be budgeted against.
 *
 * TWO SHAPES, AND THE SESSION'S IS NOT ALWAYS THE LONGER ONE (POD-2777 found
 * this while the first fix was being measured against the session label alone):
 *
 *   session          `podium-<instance>-<uuid>`          44 + len(instance)
 *   client terminal  `podium-<token>-attach-<uuid>`      53, and NOT
 *                                                        instance-prefixed
 *
 * So for any instance id shorter than 8 characters the CLIENT TERMINAL is the
 * long pole — a native view that overflows by four bytes more than the spawn
 * does, on an instance whose sessions start fine. Budgeting the session label
 * alone would leave the terminal pane silently blank on exactly the short
 * instance ids people actually pick.
 *
 * Every session uuid is 36 bytes and the token width is bounded, so the answer
 * is a constant of the instance and the root can be chosen once at boot rather
 * than per spawn. Spelled out here rather than imported from
 * `durableSessionLabel`/`clientTerminalLabel` to keep this module free of a
 * cycle back into instance.ts, which imports it, and of a dependency on
 * `packages/harness`, which depends on this package.
 */
export function longestDurableLabelFor(instanceId: string): string {
  const uuid = '0'.repeat(36)
  const session = `podium-${instanceId}-${uuid}`
  const clientTerminal = `podium-${'t'.repeat(CLIENT_TERMINAL_LABEL_TOKEN_MAX)}-attach-${uuid}`
  return session.length >= clientTerminal.length ? session : clientTerminal
}

/**
 * Pick the socket root a NAMED instance pins `ABDUCO_SOCKET_DIR` to.
 *
 * Ordered by how much isolation it buys, and the FIRST one whose composed path
 * fits is taken:
 *
 *   1. `$XDG_RUNTIME_DIR/podium-<instance>` — a private root per instance, so
 *      one instance's `abduco` listing never shows another's masters.
 *   2. `$XDG_RUNTIME_DIR/podium` — shared between instances. Nothing collides:
 *      durable labels are already instance-prefixed and carry a uuid. Only the
 *      listing is shared, and that buys back the length of the instance id.
 *   3. `<TMPDIR|/tmp>/podium-<uid>` — no user manager at all (a system service
 *      without lingering). The uid is in the name because /tmp is world
 *      writable and the root must not be a name another user can claim first.
 *
 * When NONE fits, the shortest is returned rather than nothing: a root that is
 * merely too short by a few bytes still lets abduco try, and the spawn path
 * reports the measured overflow with the path and the limit in it. Returning
 * `undefined` would instead drop the instance onto `$HOME/.abduco` — shared
 * with the default instance, and on the documented state layout too long as
 * well, so it would trade a legible failure for a confusing one.
 */
export function instanceAbducoSocketRoot(
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { username?: string; hostname?: string; uid?: number } = {},
): string {
  return instanceAbducoSocketRoots(instanceId, env, opts)[0] as string
}

/**
 * The same ladder, ORDERED — fitting roots first, then the rest shortest-first.
 *
 * The caller needs the whole list, not just the winner, because choosing a root
 * and CREATING it are different acts and the second one can fail: an
 * XDG_RUNTIME_DIR inherited from another uid, a read-only runtime directory, a
 * /tmp name already taken by another user. This used to be `<state>/runtime`,
 * which the daemon owns and can always create, so a single answer was safe.
 * A root that cannot be made must not be able to throw out of instance
 * bootstrap and take the daemon down before it has served anything.
 */
export function instanceAbducoSocketRoots(
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { username?: string; hostname?: string; uid?: number } = {},
): string[] {
  const username = opts.username ?? safeUsername()
  const uid = opts.uid ?? safeUid()
  const label = longestDurableLabelFor(instanceId)
  // The host suffix abduco appends is `@<hostname>`, and it is READ, not
  // assumed: it is 10 bytes of a 108-byte budget on this host and more on
  // others, so a placeholder would silently under-budget and hand back a root
  // that does not in fact fit. Same reason the user name is read.
  const host = `@${opts.hostname ?? safeHostname()}`

  const candidates: string[] = []
  const runtimeDir = env.XDG_RUNTIME_DIR
  if (runtimeDir) {
    candidates.push(join(runtimeDir, `podium-${instanceId}`))
    candidates.push(join(runtimeDir, 'podium'))
  }
  const tmp = env.TMPDIR || '/tmp'
  candidates.push(join(tmp, `podium-${uid}`))

  const bytesOf = (root: string) =>
    abducoSocketPathBytes(abducoSocketDir(root, username), label, host)
  const fits = (root: string) => bytesOf(root) < ABDUCO_SUN_PATH_MAX
  // Preference order among the roots that FIT (most isolation first), then the
  // ones that do not, shortest composed path first — so a caller that has to
  // settle for an over-long root at least settles for the least over-long one.
  return [
    ...candidates.filter(fits),
    ...candidates.filter((r) => !fits(r)).sort((a, b) => bytesOf(a) - bytesOf(b)),
  ]
}

function safeHostname(): string {
  try {
    return hostname()
  } catch {
    // Unreadable only on a very stripped host. Budget it as the longest name
    // POSIX guarantees room for rather than as something short: over-budgeting
    // costs a rung of isolation, under-budgeting costs the session.
    return 'h'.repeat(255)
  }
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    // No passwd entry (a stripped container): abduco falls back to the numeric
    // uid for the same subdirectory, which is never longer than a username.
    return String(safeUid())
  }
}

function safeUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}
