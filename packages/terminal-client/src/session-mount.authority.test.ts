// @vitest-environment happy-dom

/**
 * T1 / T7 (POD-3239 SPEC-1 acceptance) — where a terminal's size comes from.
 *
 * Two rules, and between them the whole of the reported bug:
 *
 *   B1  the buffer is CONSTRUCTED at the session's last-known grid W, so the
 *       first painted frame is already the right shape;
 *   B2  nothing moves it until the server has said something, and then the
 *       attach snapshot moves it — applied inside `onAttached`, because the
 *       state emit that carries it has already gone by (0b C3).
 *
 * These drive the REAL `SocketHub` rather than a stub: the emits that used to
 * drag a mounted terminal to 80x24 (`requestControl`'s synchronous publish, and
 * `welcome`'s `_notifyHubChange`) are the transport's, and a fake hub would not
 * have them to reproduce.
 */

import { type SocketHub as SocketHubType } from '@podium/client-core/socket-transport'
import { SocketHub, type WebSocketLike } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { encode, type ServerMessage } from '@podium/protocol'
import { FitAddon } from '@xterm/addon-fit'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSession } from './session-mount'

const SESSION = asSessionId('s-authority')

const restorers: Array<() => void> = []
afterEach(() => {
  while (restorers.length) restorers.pop()?.()
})

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  deliver(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

function realHub(): { hub: SocketHubType; socket: FakeSocket } {
  let socket!: FakeSocket
  const hub = new SocketHub({
    url: 'ws://authority.test',
    makeSocket: () => {
      socket = new FakeSocket()
      return socket
    },
  })
  restorers.push(() => hub.dispose())
  hub.connect()
  socket.open()
  return { hub: hub as unknown as SocketHubType, socket }
}

function withResizeObserver(): void {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const original = g.ResizeObserver
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  restorers.push(() => {
    g.ResizeObserver = original
  })
}

/** happy-dom cannot measure a cell grid; `undefined` means "never measurable",
 *  so no fit can move the buffer and every move below is the server's doing. */
function withNoProposal(): void {
  const proto = FitAddon.prototype as unknown as { proposeDimensions: () => unknown }
  const original = proto.proposeDimensions
  proto.proposeDimensions = () => undefined
  restorers.push(() => {
    proto.proposeDimensions = original
  })
}

function host(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 1200, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true })
  document.body.appendChild(el)
  return el
}

const attachedFrame = (geometry: { cols: number; rows: number }): ServerMessage =>
  ({
    type: 'attached',
    sessionId: SESSION,
    controllerId: 'someone-else',
    controllerIdentity: null,
    geometry,
    geometryRevision: 1,
    geometryState: 'current',
    epoch: 0,
    resumed: true,
    outputSeen: true,
  }) as ServerMessage

// ---------------------------------------------------------------------------
// T1
// ---------------------------------------------------------------------------

describe('T1: a mount seeded with a non-default grid is not moved by anything before the attach', () => {
  it('survives requestControl’s synchronous emit, welcome, and a spectator state — then follows the attach', () => {
    withResizeObserver()
    withNoProposal()
    const { hub, socket } = realHub()
    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      initialGeometry: { cols: 132, rows: 43 },
      geometryState: 'current',
    })
    try {
      // BORN AT W. Not 80x24, and not after a round trip — at construction.
      expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
        cols: 132,
        rows: 43,
      })

      // 1. `requestControl(geometry)` publishes a state SYNCHRONOUSLY (0b C1).
      mounted.connection.requestControl({ cols: 150, rows: 50 })
      // 2. `welcome` re-emits the same state through `_notifyHubChange`.
      socket.deliver({ type: 'welcome', clientId: 'client-1' } as ServerMessage)
      // 3. A spectator geometry frame, which a real session can receive before
      //    its own attach lands when another viewer is already driving.
      socket.deliver({
        type: 'geometry',
        sessionId: SESSION,
        cols: 90,
        rows: 30,
        geometryRevision: 1,
      } as ServerMessage)

      expect(
        { cols: mounted.view.cols(), rows: mounted.view.rows() },
        'nothing before the attach may move this buffer',
      ).toEqual({ cols: 132, rows: 43 })

      // …and now the attach, carrying a DIFFERENT grid, with no later event.
      socket.deliver(attachedFrame({ cols: 104, rows: 31 }))

      expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
        cols: 104,
        rows: 31,
      })
    } finally {
      mounted.dispose()
    }
  })

  it('an attach at the SAME grid leaves the buffer exactly where it was born', () => {
    // The reported bug's happy path (MODEL "Resolved cases", chat → CLI with W
    // unchanged): zero latency, zero movement, and no frame of a wrong size.
    withResizeObserver()
    withNoProposal()
    const { hub, socket } = realHub()
    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      initialGeometry: { cols: 104, rows: 31 },
      geometryState: 'current',
    })
    try {
      socket.deliver(attachedFrame({ cols: 104, rows: 31 }))
      expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
        cols: 104,
        rows: 31,
      })
    } finally {
      mounted.dispose()
    }
  })

  it('`unknown` still renders last-known; only `absent` declines to paint a grid', () => {
    // MODEL rule 6: inside the system W can only change through the daemon, so
    // last-known is right until the first ask corrects it. Flashing an overlay
    // over a live terminal for one round trip after every daemon restart is the
    // alternative, and it is worse.
    withResizeObserver()
    withNoProposal()
    const { hub } = realHub()
    const unknown = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      initialGeometry: { cols: 120, rows: 40 },
      geometryState: 'unknown',
    })
    expect({ cols: unknown.view.cols(), rows: unknown.view.rows() }).toEqual({
      cols: 120,
      rows: 40,
    })
    unknown.dispose()

    const absent = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      initialGeometry: { cols: 120, rows: 40 },
      geometryState: 'absent',
    })
    expect({ cols: absent.view.cols(), rows: absent.view.rows() }).toEqual({ cols: 80, rows: 24 })
    absent.dispose()
  })
})

// ---------------------------------------------------------------------------
// T7
// ---------------------------------------------------------------------------

describe('T7: a hidden pane follows the server grid, and is already correct when it is revealed', () => {
  it('a hidden pane takes a server geometry change, so the reveal has nothing to catch up on', () => {
    // MODEL rule 2, and the reason the reveal path has no work to do: every
    // viewer's buffer is always at W, visible or not. The old code let a hidden
    // pane drift and then ran a retry ladder on reveal to fix it, which is the
    // one-to-two seconds of wrong-sized terminal the bug report describes.
    withResizeObserver()
    withNoProposal()
    const { hub, socket } = realHub()
    const mounted = mountSession(host(), {
      hub,
      sessionId: SESSION,
      active: false,
      initialGeometry: { cols: 132, rows: 43 },
      geometryState: 'current',
    })
    try {
      socket.deliver(attachedFrame({ cols: 132, rows: 43 }))

      // The desktop resizes its window while this pane is hidden behind chat.
      socket.deliver({
        type: 'geometry',
        sessionId: SESSION,
        cols: 100,
        rows: 30,
        geometryRevision: 2,
      } as ServerMessage)

      expect(
        { cols: mounted.view.cols(), rows: mounted.view.rows() },
        'a hidden pane follows W',
      ).toEqual({ cols: 100, rows: 30 })

      // Reveal. Nothing measurable, so no fit can run — and none is needed.
      mounted.setActive(true)
      expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
        cols: 100,
        rows: 30,
      })
    } finally {
      mounted.dispose()
    }
  })
})
