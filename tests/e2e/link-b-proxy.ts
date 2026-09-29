/**
 * LINK B, CUTTABLE FROM OUTSIDE (POD-4773).
 *
 * The daemon reaches the server over one websocket ("link B" in POD-3190's
 * size design). A test that wants to drop ONLY that link — the browsers stay
 * connected, the server and the daemon both keep running — cannot ask either
 * side to do it: a drop the system under test performs on itself is a code
 * path, not a network fault. So the harness puts a plain TCP pipe between the
 * two and the test cuts the pipe.
 *
 * `cut()` destroys every open pair and refuses new connections until
 * `restore()`, so the daemon's reconnect loop fails for as long as the link is
 * down, exactly as it would against a dead network.
 */
import { connect, createServer, type Socket } from 'node:net'

export interface LinkProxy {
  /** The port the daemon should dial instead of the server's. */
  readonly port: number
  readonly down: boolean
  cut(): void
  restore(): void
  close(): Promise<void>
}

export async function startLinkProxy(targetPort: number): Promise<LinkProxy> {
  const open = new Set<Socket>()
  let down = false
  const server = createServer((client) => {
    if (down) {
      client.destroy()
      return
    }
    const upstream = connect(targetPort, 'localhost')
    open.add(client)
    open.add(upstream)
    const drop = (): void => {
      client.destroy()
      upstream.destroy()
      open.delete(client)
      open.delete(upstream)
    }
    for (const socket of [client, upstream]) {
      socket.on('error', drop)
      socket.on('close', drop)
    }
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('link proxy has no port')
  return {
    port: address.port,
    get down() {
      return down
    },
    cut() {
      down = true
      for (const socket of open) socket.destroy()
      open.clear()
    },
    restore() {
      down = false
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
