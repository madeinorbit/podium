import { encode } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_PLANE_LIVENESS,
  DAEMON_PLANE_LIVENESS,
  definePlaneLiveness,
  type HeartbeatSocket,
  type SweepTimers,
  sweepPlaneLiveness,
} from './gateway/plane-liveness'
import { safeSend, safeSendEncoded } from './gateway/ws-send'
import { attachWebSockets } from './gateway/ws-server'

function fakeSocket(readyState = 1) {
  return { readyState, ping: vi.fn(), terminate: vi.fn() }
}

function fakeSendSocket(over: { readyState?: number; bufferedAmount?: number } = {}) {
  return {
    readyState: over.readyState ?? 1,
    bufferedAmount: over.bufferedAmount ?? 0,
    send: vi.fn<(data: string) => void>(),
    terminate: vi.fn<() => void>(),
  }
}

describe('safeSend', () => {
  const msg = { type: 'pong' } as const
  const LIMIT = 1000

  it('encodes and sends when the socket is OPEN and under the buffer limit', () => {
    const ws = fakeSendSocket({ bufferedAmount: 10 })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(ws.send).toHaveBeenCalledWith(encode(msg))
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('sends already-prepared publication bytes without encoding them again', () => {
    const ws = fakeSendSocket()
    const bytes = '{"type":"sessionsChanged","sessions":[]}'
    safeSendEncoded(ws, bytes, LIMIT)
    expect(ws.send).toHaveBeenCalledWith(bytes)
  })

  it('terminates (does not send) a slow socket whose send buffer exceeds the limit', () => {
    const ws = fakeSendSocket({ bufferedAmount: LIMIT + 1 })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('a socket buffered at EXACTLY the limit still receives (the cap is >, not >=)', () => {
    // What starves when this arm binds is a live recipient, so the boundary has to
    // be pinned from BOTH sides: the `LIMIT + 1` case above alone is satisfied by
    // any off-by-one, and `>=` would reap a client that is exactly at budget.
    const ws = fakeSendSocket({ bufferedAmount: LIMIT })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('does nothing for a socket that is not OPEN', () => {
    const ws = fakeSendSocket({ readyState: 0 /* CONNECTING */ })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('a not-OPEN socket over the limit is dropped, NOT terminated (readyState gates first)', () => {
    // Forces the readyState arm specifically. A socket that is merely closed and a
    // socket that is closed AND over budget must take the same path — otherwise
    // "over the limit" would re-terminate an already-closing socket on every
    // queued frame during a storm, which is the arm that turns a reattach burst
    // into a terminate burst. A test using only an OPEN over-limit socket proves
    // nothing about the ordering of the two conditions.
    const ws = fakeSendSocket({ readyState: 2 /* CLOSING */, bufferedAmount: LIMIT * 10 })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('swallows a throwing send (socket died mid-send) without rethrowing or terminating', () => {
    const ws = fakeSendSocket()
    ws.send.mockImplementation(() => {
      throw new Error('WebSocket is not open')
    })
    expect(() => safeSend(ws, msg, LIMIT)).not.toThrow()
    expect(ws.terminate).not.toHaveBeenCalled()
  })
})

describe('sweepPlaneLiveness', () => {
  it('pings a live (alive-marked) socket and clears its mark', () => {
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepPlaneLiveness([ws], alive)
    expect(ws.ping).toHaveBeenCalledOnce()
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(alive.has(ws)).toBe(false) // mark cleared — must pong again to survive next sweep
  })

  it('terminates a socket that did not pong since the previous sweep', () => {
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepPlaneLiveness([ws], alive) // pings, clears mark
    sweepPlaneLiveness([ws], alive) // no pong arrived → reaped
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('a socket that pongs between sweeps survives', () => {
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepPlaneLiveness([ws], alive) // clears mark
    alive.add(ws) // pong handler re-marks it
    sweepPlaneLiveness([ws], alive)
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(ws.ping).toHaveBeenCalledTimes(2)
  })

  it('does not ping a socket that is not OPEN', () => {
    const ws = fakeSocket(0 /* CONNECTING */)
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepPlaneLiveness([ws], alive)
    expect(ws.ping).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('a ping that throws (socket vanished mid-sweep) does not abort the sweep', () => {
    const bad = fakeSocket()
    bad.ping.mockImplementation(() => {
      throw new Error('WebSocket is not open')
    })
    const good = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([bad, good])
    expect(() => sweepPlaneLiveness([bad, good], alive)).not.toThrow()
    expect(good.ping).toHaveBeenCalledOnce()
  })

  it('a socket that keeps ponging is never reaped, however many sweeps run', () => {
    // The starvation direction of the reaping rule: two sweeps is the DEADLINE for
    // a silent socket, not a lifetime for a talking one. Without this, a mutant
    // that reaps on a counter rather than on the liveness mark passes every case
    // above (each of which runs at most two sweeps).
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    for (let i = 0; i < 10; i++) {
      sweepPlaneLiveness([ws], alive)
      alive.add(ws) // pong handler re-marks it between sweeps
    }
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(ws.ping).toHaveBeenCalledTimes(10)
  })
})

/**
 * PER-PLANE POLICY (POD-391). The plane applies its own budget and its own
 * cadence; no caller passes either. These tests exist because the two shipped
 * planes share a cap VALUE (16 MB), so an implementation that hard-codes the
 * value and one that reads the policy are indistinguishable from the shipped
 * constants alone — every wiring assertion below therefore runs against a
 * synthetic policy whose numbers are nothing like the shipped ones.
 */
describe('plane liveness policy', () => {
  /** A `SweepTimers` double: records what was scheduled, lets the test fire it. */
  function fakeTimers() {
    const scheduled: { fn: () => void; ms: number; cleared: boolean }[] = []
    const timers: SweepTimers = {
      setInterval: (fn, ms) => {
        scheduled.push({ fn, ms, cleared: false })
        return scheduled.length - 1
      },
      clearInterval: (handle) => {
        const entry = scheduled[handle as number]
        if (entry) entry.cleared = true
      },
    }
    return { scheduled, timers }
  }

  describe('the shipped values (ADR 7 Am. 1 D11.6 freezes both cadences)', () => {
    it('the client plane sweeps at 15s with a 16 MB budget', () => {
      expect(CLIENT_PLANE_LIVENESS.peer).toBe('client')
      expect(CLIENT_PLANE_LIVENESS.heartbeatIntervalMs).toBe(15_000)
      expect(CLIENT_PLANE_LIVENESS.sendBufferLimitBytes).toBe(16 * 1024 * 1024)
      expect(CLIENT_PLANE_LIVENESS.lossySendBufferLimitBytes).toBe(256 * 1024)
    })

    it('the daemon plane sweeps at 10s with a 16 MB budget', () => {
      expect(DAEMON_PLANE_LIVENESS.peer).toBe('daemon')
      expect(DAEMON_PLANE_LIVENESS.heartbeatIntervalMs).toBe(10_000)
      expect(DAEMON_PLANE_LIVENESS.sendBufferLimitBytes).toBe(16 * 1024 * 1024)
    })

    it('the daemon link is swept STRICTLY more often than the client link', () => {
      // The asymmetry itself, stated as a property rather than as two literals: a
      // wedged daemon is silent and total (no `close`, no self-heal), a departed
      // browser reconnects on its own. Equalising the two cadences would pass both
      // tests above only by changing a literal each reviewer would see; this fails
      // on any change that erases the ordering.
      expect(DAEMON_PLANE_LIVENESS.heartbeatIntervalMs).toBeLessThan(
        CLIENT_PLANE_LIVENESS.heartbeatIntervalMs,
      )
    })
  })

  describe('sink() — the budget binds from the policy, not from the call site', () => {
    const tiny = definePlaneLiveness({
      peer: 'client',
      heartbeatIntervalMs: 1,
      sendBufferLimitBytes: 100,
      lossySendBufferLimitBytes: 10,
    })

    it('sends through a socket under THIS policy s budget', () => {
      const ws = fakeSendSocket({ bufferedAmount: 100 })
      tiny.sink(ws).send({ type: 'pong' })
      expect(ws.send).toHaveBeenCalledOnce()
      expect(ws.terminate).not.toHaveBeenCalled()
    })

    it('terminates a socket over THIS policy s budget — far below the shipped 16 MB', () => {
      // 101 bytes is ~6 orders of magnitude under the shipped cap. A `sink()` that
      // hard-coded 16 MB (or read the other plane's constant) would send here.
      const ws = fakeSendSocket({ bufferedAmount: 101 })
      tiny.sink(ws).send({ type: 'pong' })
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.terminate).toHaveBeenCalledOnce()
    })

    it('caps the prepared-bytes path too (the client plane s second outbound door)', () => {
      // POD-390 routed every byte to a client socket through deliver /
      // deliverPrepared / broadcast. `deliverPrepared` reaches the socket by a
      // DIFFERENT function, so a cap applied only to `send` would leave the
      // publication worker's output — the highest-volume path on the plane —
      // uncapped. That is the fan-out this budget exists to bound.
      const ws = fakeSendSocket({ bufferedAmount: 101 })
      tiny.sink(ws).sendPrepared('{"type":"sessionsChanged","sessions":[]}')
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.terminate).toHaveBeenCalledOnce()
    })

    it('drops stream frames over the lower budget without terminating control', () => {
      const ws = fakeSendSocket({ bufferedAmount: 11 })
      const sink = tiny.sink(ws)
      expect(sink.sendLossy({ type: 'pong' })).toBe(false)
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.terminate).not.toHaveBeenCalled()

      // The same socket remains below the control budget and stays usable.
      sink.send({ type: 'pong' })
      expect(ws.send).toHaveBeenCalledOnce()
      expect(ws.terminate).not.toHaveBeenCalled()
    })

    it('sends stream frames at the lower budget boundary', () => {
      const ws = fakeSendSocket({ bufferedAmount: 10 })
      expect(tiny.sink(ws).sendLossy({ type: 'pong' })).toBe(true)
      expect(ws.send).toHaveBeenCalledOnce()
      expect(ws.terminate).not.toHaveBeenCalled()
    })

    it('the two shipped planes hand out sinks that each carry their own peer s budget', () => {
      // Both are 16 MB today, so this cannot distinguish them by value — it pins
      // that each policy is independently usable and neither delegates to a shared
      // mutable limit. The value-distinguishing case is the synthetic policy above.
      for (const policy of [CLIENT_PLANE_LIVENESS, DAEMON_PLANE_LIVENESS]) {
        const over = fakeSendSocket({ bufferedAmount: policy.sendBufferLimitBytes + 1 })
        const under = fakeSendSocket({ bufferedAmount: policy.sendBufferLimitBytes })
        policy.sink(over).send({ type: 'pong' })
        policy.sink(under).send({ type: 'pong' })
        expect(over.terminate, `${policy.peer} over budget`).toHaveBeenCalledOnce()
        expect(under.send, `${policy.peer} at budget`).toHaveBeenCalledOnce()
      }
    })
  })

  describe('startHeartbeat() — the cadence binds from the policy, on an injected clock', () => {
    it('schedules the sweep at THIS policy s interval', () => {
      const { scheduled, timers } = fakeTimers()
      definePlaneLiveness({
        peer: 'daemon',
        heartbeatIntervalMs: 777,
        sendBufferLimitBytes: 1,
      }).startHeartbeat([], new WeakSet(), timers)
      expect(scheduled).toHaveLength(1)
      expect(scheduled[0]?.ms).toBe(777)
    })

    it('each shipped plane schedules at its own cadence, not the other s', () => {
      // The regression this replaces: `ws-server.ts` used to build both intervals
      // itself, so pairing the client socket set with the daemon interval (or vice
      // versa) compiled, type-checked and passed every test in the repo.
      const { scheduled, timers } = fakeTimers()
      CLIENT_PLANE_LIVENESS.startHeartbeat([], new WeakSet(), timers)
      DAEMON_PLANE_LIVENESS.startHeartbeat([], new WeakSet(), timers)
      expect(scheduled.map((s) => s.ms)).toEqual([15_000, 10_000])
    })

    it('a tick sweeps the live set — including sockets added AFTER it started', () => {
      // `wss.clients` is mutated by the ws layer as peers connect; a heartbeat that
      // snapshotted the set at start would never sweep a socket that connected
      // afterwards, which under a reattach storm is EVERY socket.
      const { scheduled, timers } = fakeTimers()
      const sockets = new Set<HeartbeatSocket>()
      const alive = new WeakSet<HeartbeatSocket>()
      CLIENT_PLANE_LIVENESS.startHeartbeat(sockets, alive, timers)

      const late = fakeSocket()
      sockets.add(late)
      alive.add(late)
      scheduled[0]?.fn() // marked alive → pinged, mark cleared
      expect(late.ping).toHaveBeenCalledOnce()
      expect(late.terminate).not.toHaveBeenCalled()
      scheduled[0]?.fn() // no pong arrived → reaped, two sweeps after joining
      expect(late.terminate).toHaveBeenCalledOnce()
    })

    it('stop() clears its OWN timer and leaves the other plane s running', () => {
      const { scheduled, timers } = fakeTimers()
      const client = CLIENT_PLANE_LIVENESS.startHeartbeat([], new WeakSet(), timers)
      DAEMON_PLANE_LIVENESS.startHeartbeat([], new WeakSet(), timers)
      client.stop()
      expect(scheduled.map((s) => s.cleared)).toEqual([true, false])
    })
  })

  describe('the gateway wires each socket set to its own plane', () => {
    // The one thing the policy objects cannot enforce for themselves: which
    // SOCKET SET each is handed. Mutating `attachWebSockets` to pair the CLIENT
    // set with the DAEMON plane's policy compiled and survived 45 tests across
    // four suites — the interval travels with the policy, so that mutant silently
    // swept browsers on the daemon's 10s cadence. It is caught here by cadence:
    // the mutant schedules [10_000, 10_000], not [15_000, 10_000].
    //
    // No real HTTP server: `attachWebSockets` only registers an `upgrade`
    // listener, and both `WebSocketServer`s are `noServer`. So this stays in the
    // unit lane, with an injected clock and nothing to bind or tear down.
    const fakeHttpServer = { on: () => {} } as unknown as Parameters<typeof attachWebSockets>[0]
    const unusedRegistry = {} as unknown as Parameters<typeof attachWebSockets>[1]

    it('schedules the client sweep at 15s and the daemon sweep at 10s', () => {
      const { scheduled, timers } = fakeTimers()
      const handle = attachWebSockets(fakeHttpServer, unusedRegistry, {}, { timers })
      expect(scheduled.map((s) => s.ms)).toEqual([15_000, 10_000])
      void handle.close()
    })

    it('close() stops BOTH sweeps', () => {
      // A leaked sweep keeps terminating sockets on a gateway that is shutting
      // down, and (before `unref`) would hold the process open.
      const { scheduled, timers } = fakeTimers()
      const handle = attachWebSockets(fakeHttpServer, unusedRegistry, {}, { timers })
      void handle.close()
      expect(scheduled.map((s) => s.cleared)).toEqual([true, true])
    })
  })
})
