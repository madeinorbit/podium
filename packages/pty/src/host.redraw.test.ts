import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { expect, it, vi } from 'vitest'
import { attachHostAgent } from './host.js'

vi.mock('node:net', () => ({ createConnection: vi.fn() }))

it.each([false, true])('contains a pre-WELCOME connection failure during redraw (hard=%s)', async (hard) => {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  })
  vi.mocked(createConnection).mockReturnValue(socket as unknown as ReturnType<typeof createConnection>)
  const session = attachHostAgent({ label: 'redraw-failure', socketPath: '/unused/redraw.sock' })
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const failure = new Error('connect ECONNREFUSED')
    const readyError = session.ready.catch((error: unknown) => error)
    expect(session.redraw({ hard })).toBeUndefined()
    socket.emit('error', failure)
    expect(await readyError).toBe(failure)
    // Let Node report any rejected promise derived from ready.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])
    // HELLO only: the failed redraw must not write Ctrl-L or RESIZE.
    expect(socket.write).toHaveBeenCalledTimes(1)
  } finally {
    session.dispose()
    process.off('unhandledRejection', onUnhandled)
  }
})
