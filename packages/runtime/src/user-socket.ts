/**
 * USER-ONLY UNIX SOCKETS — the one way a local process talks to Podium (POD-4640).
 *
 * The question a local caller has to answer is "am I a process of the same OS
 * user as this server?". The kernel already answers it: a socket in a 0700
 * directory, itself 0600, cannot be connected to by anyone else. So nothing is
 * minted, stored, expired or rotated, and — unlike a loopback TCP port — the
 * socket is not reachable through anything that forwards network traffic to
 * 127.0.0.1, such as a Cloudflare tunnel. podium-host's session sockets work the
 * same way (0600 plus a peer-uid check, vendor/podium-host/host.c).
 *
 * Used by the daemon's Codex hook socket and the server's control socket.
 */

import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { stateDir } from './config'
import { instanceSocketRuntimeDir, linuxUnixSocketPathFits, resolveInstanceId } from './instance'

/**
 * Get `path` ready to listen on: its directory exists and is 0700, and a
 * socket file a crashed process left behind is removed. A socket someone is
 * still LISTENING on is never unlinked — that would silently steal it from a
 * live process — so it fails with EADDRINUSE instead.
 */
export async function prepareUserSocketPath(path: string, purpose: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy()
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') resolve(false)
      else reject(err)
    })
  })
  if (live) {
    const err = new Error(`${purpose} already in use: ${path}`) as NodeJS.ErrnoException
    err.code = 'EADDRINUSE'
    throw err
  }
  await rm(path, { force: true })
}

/**
 * Where the server's control socket lives: `<stateDir>/run/control.sock`, next
 * to the run registry. On Linux a unix socket path is limited to 107 bytes, so
 * a state root too deep for that moves the socket to the same short per-instance
 * directory the daemon's hook socket falls back to (`instanceSocketRuntimeDir`).
 * Server and callers derive it the same way, so neither needs to be told.
 */
export function serverControlSocketPath(
  opts: { root?: string; instanceId?: string; platform?: NodeJS.Platform } = {},
): string {
  const root = opts.root ?? stateDir()
  const preferred = join(root, 'run', 'control.sock')
  if ((opts.platform ?? process.platform) !== 'linux' || linuxUnixSocketPathFits(preferred)) {
    return preferred
  }
  return join(
    instanceSocketRuntimeDir(opts.instanceId ?? resolveInstanceId(), root),
    'control.sock',
  )
}

/** An HTTP server listening on a user-only unix socket. */
export interface UserSocketServer {
  readonly path: string
  close(): Promise<void>
}

/**
 * Serve `handler` on a user-only unix socket at `path`. The socket file is
 * chmodded to 0600 before this resolves, and removed again on close.
 */
export async function listenUserSocket(
  path: string,
  handler: RequestListener,
  purpose: string,
): Promise<UserSocketServer> {
  await prepareUserSocketPath(path, purpose)
  const server: Server = createServer(handler)
  let listening = false
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
    listening = true
    await chmod(path, 0o600)
  } catch (err) {
    if (listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(path, { force: true })
    throw err
  }
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(path, { force: true })
    },
  }
}
