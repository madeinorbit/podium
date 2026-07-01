import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAddressInUseError, PortInUseError, startServer } from './server'

// Regression for issue #8: on a box where the systemd podium-server already holds
// :18787, running the `podium` CLI tried to bind the same port. @hono/node-server's
// serve() registers no 'error' handler, so on Bun the failed listen() throws
// synchronously out of startServer's Promise executor — surfacing as a swallowed
// "uncaughtException (surviving)" and a hung/never-resolving startServer. startServer
// must instead REJECT with a typed, port-carrying error so callers can react cleanly.
describe('startServer port-in-use handling', () => {
  const dirs: string[] = []
  let held: Awaited<ReturnType<typeof startServer>> | undefined

  afterEach(async () => {
    if (held) await held.close()
    held = undefined
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  function useFreshStateDir(tag: string): void {
    const d = mkdtempSync(join(tmpdir(), `podium-portinuse-${tag}-`))
    dirs.push(d)
    process.env.PODIUM_STATE_DIR = d
  }

  it('rejects with a typed PortInUseError (never a swallowed throw) when the port is taken', async () => {
    useFreshStateDir('held')
    held = await startServer({ port: 0 })
    const { port } = held

    useFreshStateDir('second')
    const outcome = await startServer({ port }).then(
      (s) => {
        // If it somehow bound, don't leak — close it, then let the assertion fail.
        void s.close()
        return null
      },
      (e: unknown) => e,
    )

    expect(outcome).toBeInstanceOf(PortInUseError)
    expect(isAddressInUseError(outcome)).toBe(true)
    expect((outcome as PortInUseError).port).toBe(port)
  })

  it('isAddressInUseError recognizes a raw EADDRINUSE errno as well as PortInUseError', () => {
    expect(isAddressInUseError(new PortInUseError(18787))).toBe(true)
    expect(isAddressInUseError(Object.assign(new Error('listen'), { code: 'EADDRINUSE' }))).toBe(
      true,
    )
    expect(isAddressInUseError(new Error('something else'))).toBe(false)
    expect(isAddressInUseError(null)).toBe(false)
  })
})
