import { describe, expect, it, vi } from 'vitest'
import { onReconnect } from './on-reconnect'

type Health = { status: 'ok' | 'degraded' | 'down' }

/** Stands in for `hub.onConnectionHealth`, replay on subscribe included. */
function hub(initial: Health = { status: 'ok' }) {
  let listener: ((h: Health) => void) | undefined
  let unsubscribed = false
  return {
    subscribe(next: (h: Health) => void): () => void {
      listener = next
      next(initial)
      return () => {
        unsubscribed = true
      }
    },
    emit(status: Health['status']): void {
      listener?.({ status })
    },
    get unsubscribed(): boolean {
      return unsubscribed
    },
  }
}

describe('onReconnect', () => {
  it('fires when the socket goes down and comes back', () => {
    const fired = vi.fn()
    const socket = hub()
    onReconnect(socket.subscribe, fired)

    socket.emit('down')
    expect(fired).not.toHaveBeenCalled()
    socket.emit('ok')
    expect(fired).toHaveBeenCalledTimes(1)
  })

  /**
   * The sequence the sandbox actually logged: closed at 13:47:37, reconnecting,
   * connected at 13:47:38 — under two seconds, and the window in which the
   * served website changed.
   */
  it('fires for a sub-second blip, which is what a server restart looks like', () => {
    const fired = vi.fn()
    const socket = hub()
    onReconnect(socket.subscribe, fired)

    socket.emit('down')
    socket.emit('down')
    socket.emit('ok')
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('fires again on the next outage', () => {
    const fired = vi.fn()
    const socket = hub()
    onReconnect(socket.subscribe, fired)

    socket.emit('down')
    socket.emit('ok')
    socket.emit('down')
    socket.emit('ok')
    expect(fired).toHaveBeenCalledTimes(2)
  })

  /**
   * CAN SAY NO — each of these would turn a callback into a poll, and the boot
   * check has already asked the question the replayed value would re-ask.
   */
  it('does not fire on the health replayed at subscribe time', () => {
    const fired = vi.fn()
    onReconnect(hub({ status: 'ok' }).subscribe, fired)
    expect(fired).not.toHaveBeenCalled()
  })

  it('does not fire on a healthy socket re-reporting itself', () => {
    const fired = vi.fn()
    const socket = hub()
    onReconnect(socket.subscribe, fired)

    socket.emit('ok')
    socket.emit('ok')
    expect(fired).not.toHaveBeenCalled()
  })

  it('does not treat a slow socket that recovered as a reconnect', () => {
    const fired = vi.fn()
    const socket = hub()
    onReconnect(socket.subscribe, fired)

    socket.emit('degraded')
    socket.emit('ok')
    expect(fired).not.toHaveBeenCalled()
  })

  it('does not lose the outage to a degraded reading on the way back', () => {
    const fired = vi.fn()
    const socket = hub()
    onReconnect(socket.subscribe, fired)

    socket.emit('down')
    socket.emit('degraded')
    socket.emit('ok')
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('hands back the unsubscribe so the effect can clean up', () => {
    const socket = hub()
    onReconnect(socket.subscribe, vi.fn())()
    expect(socket.unsubscribed).toBe(true)
  })
})
