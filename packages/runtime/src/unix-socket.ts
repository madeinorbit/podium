/**
 * THE UNIX SOCKET PATH BUDGET [spec:SP-0be7].
 *
 * A durable session IS a unix socket, and a unix socket path has a hard kernel
 * ceiling: `sizeof(struct sockaddr_un.sun_path)` is 108 bytes on Linux, and a
 * path must be strictly shorter than that to leave room for the terminating
 * NUL. Every socket Podium binds — a podium-host's, a Codex app-server's — is
 * measured against it, and a path over the ceiling must be refused with the
 * path and the number rather than the kernel's bare ENAMETOOLONG (POD-2853).
 *
 * Formerly `abduco-socket.ts`. The root a named instance pins
 * `ABDUCO_SOCKET_DIR` to — where adoption finds the abduco sessions an older
 * Podium started (POD-4986) — is chosen in `instance.ts`
 * (`applyInstanceRuntimeEnv`); only the backend-neutral budget lives here.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `sizeof(struct sockaddr_un.sun_path)` on Linux. macOS is 104, so the Linux
 * number is not a safe upper bound everywhere; it is the one that matters for
 * the scoped durable host, which is Linux-first (the scope needs systemd).
 */
export const SUN_PATH_MAX = 108

/** Number of UTF-8 bytes occupied by a complete Unix socket pathname. */
export function unixSocketPathBytes(path: string): number {
  return Buffer.byteLength(path, 'utf8')
}

/** Unix socket paths must be strictly shorter than `sun_path`, not equal to it. */
export function unixSocketPathFits(path: string): boolean {
  return unixSocketPathBytes(path) < SUN_PATH_MAX
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
 * The LONGEST durable label this instance can mint:
 *
 *   session          `podium-<instance>-<uuid>`          44 + len(instance)
 *   client terminal  `podium-<token>-attach-<uuid>`      53, and NOT
 *                                                        instance-prefixed
 *
 * So for any instance id shorter than 8 characters the CLIENT TERMINAL is the
 * long pole (POD-2777). Spelled out here rather than imported from
 * `durableSessionLabel`/`clientTerminalLabel` to keep this module free of a
 * cycle back into instance.ts and of a dependency on `packages/harness`.
 */
export function longestDurableLabelFor(instanceId: string): string {
  const uuid = '0'.repeat(36)
  const session = `podium-${instanceId}-${uuid}`
  const clientTerminal = `podium-${'t'.repeat(CLIENT_TERMINAL_LABEL_TOKEN_MAX)}-attach-${uuid}`
  return session.length >= clientTerminal.length ? session : clientTerminal
}

/**
 * The private runtime root for a Podium-owned Unix socket.
 *
 * The instance id is deliberately kept in the root name: a Codex app-server
 * basename has no instance identity of its own, so sharing one directory would
 * make cleanup and ownership ambiguous. The root is the socket directory
 * itself; the short Codex basename is placed directly inside it, with no
 * state-tree or descriptive directory segments.
 *
 * `XDG_RUNTIME_DIR` is already private to the user and is removed with the
 * login session. A system service with `User=` may not inherit it, so use the
 * same fixed logind path when it exists. If no user runtime namespace exists,
 * the `/tmp` fallback includes both uid and instance id so another user cannot
 * claim the name first and collapse the isolation boundary.
 */
export function instanceRuntimeSocketRoot(
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { uid?: number } = {},
): string {
  const uid = opts.uid ?? safeUid()
  const runtimeDir = userRuntimeDir(env, uid)
  return runtimeDir
    ? join(runtimeDir, `podium-${instanceId}`)
    : join('/tmp', `podium-${uid}-${instanceId}`)
}

function safeUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

function userRuntimeDir(env: NodeJS.ProcessEnv, uid: number): string | undefined {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR
  if (process.platform !== 'linux') return undefined
  const dir = `/run/user/${uid}`
  return existsSync(dir) ? dir : undefined
}
