// @vitest-environment happy-dom
// Terminal-mount integration (POD-5615): drives the real server SessionTerminal
// against the real client mount + SocketHub. Lives with the server because
// terminal-client (L2) may not reach up into apps/server (L4) or client-core
// (L3); POD-1543 owns the socket-transport inversion that would let these
// tests move back down.

import { SocketHub, type WebSocketLike } from '@podium/client-core/socket-transport'
import { asSessionId, asUserId } from '@podium/model'
import {
  CLIENT_WIRE_VERSION,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionTerminal } from './terminal'
import { mountSession, type MountedSession } from '@podium/terminal-client/session-mount'

const SESSION = asSessionId('phone-query-replies')
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
})

class Socket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(private readonly receive: (msg: ClientMessage) => void) {}
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.receive(JSON.parse(data))
  }
  close(): void {}
  deliver(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

/** Real mounts, transport and server sizing; only glyph/layout primitives and
 * the daemon's geometry acknowledgement are supplied by this hermetic fixture. */
function fixture(withDesktop = true) {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('devicePixelRatio', 3)
  const requests: Array<{ client: string; cols: number; claimControl: boolean }> = []
  const resizes: Array<{ client: string | null; cols: number }> = []
  const input: Array<{ client: string; data: string }> = []
  const server = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'codex',
    geometry: { cols: 83, rows: 40 },
    toDaemon: (msg) => {
      if (msg.type !== 'resize') return
      resizes.push({ client: server.controllerId, cols: msg.cols })
      server.applyDaemonGeometry({ cols: msg.cols, rows: msg.rows })
    },
  })
  cleanups.push(() => server.detachAll())

  function viewer(id: string, width: number, fontSize: number, cellWidth: number) {
    let socket!: Socket
    const client: ClientConn = {
      id,
      principal: userClientPrincipal(id, asUserId('phone-query-owner'), 'admin'),
      send: (msg) => socket.deliver(msg),
      viewports: new Map(),
      attached: new Set(),
      caps: new Set(),
      wireVersion: CLIENT_WIRE_VERSION,
      transcriptSubs: new Set(),
      visible: true,
      viewVisible: new Set(),
      focused: null,
      viewModes: {},
    }
    const hub = new SocketHub({
      url: 'ws://phone-sizing.test',
      makeSocket: () => {
        socket = new Socket((msg) => {
          if (msg.type === 'viewState') {
            client.viewVisible = new Set(msg.visible)
            client.viewModes = msg.modes ?? {}
          } else if (msg.type === 'viewportRequest') {
            requests.push({ client: id, cols: msg.geometry.cols, claimControl: msg.claimControl })
            server.handleViewportRequest(id, msg)
          } else if (msg.type === 'input') {
            input.push({ client: id, data: atob(msg.data) })
          }
        })
        return socket
      },
    })
    cleanups.push(() => hub.dispose())
    hub.connect()
    socket.onopen?.({})
    socket.deliver({ type: 'welcome', clientId: id } as ServerMessage)

    const viewport = document.createElement('div')
    viewport.style.cssText = `width:${width}px;height:480px;overflow:auto`
    viewport.getBoundingClientRect = () => ({ width, height: 480 }) as DOMRect
    const host = document.createElement('div')
    Object.defineProperties(host, { clientWidth: { value: width }, clientHeight: { value: 480 } })
    viewport.append(host)
    document.body.append(viewport)
    const toolbar = document.createElement('div')
    document.body.append(toolbar)
    const mounted = mountSession(host, {
      hub,
      sessionId: SESSION,
      viewportEl: viewport,
      toolbarEl: toolbar,
      crop: id === 'phone' ? 'scroll' : 'clip',
      appearance: { fontSize, fontFamily: 'monospace' },
      focusOnMount: false,
    })
    cleanups.push(() => mounted.dispose())
    const term = (
      mounted.view as unknown as {
        term: {
          input(data: string): void
          _core: {
            _renderService: {
              readonly dimensions: { device: { cell: { width: number; height: number } } }
            }
          }
        }
      }
    ).term
    const render = term._core._renderService
    const dimensions = render.dimensions
    vi.spyOn(render, 'dimensions', 'get').mockReturnValue({
      ...dimensions,
      device: { ...dimensions.device, cell: { width: cellWidth * 3, height: 36 } },
    })
    server.attachClient(client)
    return { mounted, term, toolbar }
  }

  // 402 CSS px / 6 px per glyph = 67 columns. The desktop's independently
  // measured 647.4 CSS px / 7.8 px glyph = 83. Neither changes during output.
  const desktop = withDesktop ? viewer('desktop', 647.4, 13, 7.8) : undefined
  const phone = viewer('phone', 402, 10, 6)
  vi.advanceTimersByTime(100)
  requests.length = resizes.length = input.length = 0
  return { server, phone, desktop, requests, resizes, input }
}

async function frame(mounted: MountedSession, query: string): Promise<void> {
  // The product's output path parses this with xterm, which emits its own reply.
  // No synthetic keystroke, resize trigger or control claim is injected.
  mounted.view.write(query)
  await vi.advanceTimersByTimeAsync(20)
}

describe('terminal replies cannot claim a phone viewport', () => {
  it('keeps two attached viewers at one owner instead of alternating 67/83 columns', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) {
      await frame(f.phone.mounted, '\x1b[6n')
      await frame(f.desktop!.mounted, '\x1b[6n')
    }
    console.info('query resize sequence', JSON.stringify(f.resizes))
    expect(f.requests, 'automatic cursor replies must not claim either viewport').toEqual([])
    expect(f.resizes, 'fixed phone/desktop boxes must not ping-pong ownership').toEqual([])
    expect(f.server.controllerId).toBe('desktop')
    expect(f.input).toEqual(
      Array.from({ length: 3 }, () => ({ client: 'desktop', data: '\x1b[1;1R' })),
    )
  })

  it('answers queries from the sole phone controller without making a claim', async () => {
    const f = fixture(false)
    await frame(f.phone.mounted, '\x1b[6n\x1b]11;?\x07\x1b[c')
    expect(f.requests).toEqual([])
    expect(f.resizes).toEqual([])
    expect(f.input.map((entry) => entry.client)).toEqual(['phone', 'phone', 'phone'])
    expect(f.input[0]!.data).toBe('\x1b[1;1R')
    expect(f.input[1]!.data).toMatch(/^\x1b\]11;rgb:/)
    expect(f.input[2]!.data).toBe('\x1b[?1;2c')
  })

  it('keeps a phone Ctrl modifier armed through automatic replies', async () => {
    const f = fixture(false)
    f.phone.toolbar.querySelector<HTMLButtonElement>('[data-key="Ctrl"]')!.click()
    await frame(f.phone.mounted, '\x1b[6n')
    expect(f.input).toEqual([{ client: 'phone', data: '\x1b[1;1R' }])
    f.phone.term.input('c')
    expect(f.input.at(-1)).toEqual({ client: 'phone', data: '\x03' })
  })

  it('still lets phone typing and paste take control with its 67-column box', async () => {
    const f = fixture()
    f.phone.term.input('x')
    expect(f.requests).toEqual([{ client: 'phone', cols: 67, claimControl: true }])
    expect(f.resizes).toEqual([{ client: 'phone', cols: 67 }])
    expect(f.input).toEqual([{ client: 'phone', data: 'x' }])
    f.server.requestControl('desktop')
    f.requests.length = f.resizes.length = f.input.length = 0
    f.phone.mounted.view.pasteText('pasted')
    expect(f.requests).toEqual([{ client: 'phone', cols: 67, claimControl: true }])
    expect(f.input).toEqual([{ client: 'phone', data: 'pasted' }])
    await frame(f.phone.mounted, '\x1b[6n')
    expect(f.requests).toHaveLength(1) // The user-input marker was consumed by paste.
  })
})
