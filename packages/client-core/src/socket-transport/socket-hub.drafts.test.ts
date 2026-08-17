/**
 * THE DRAFT WIRE, FROM THE CLIENT'S SIDE (POD-2045).
 *
 * Two properties this suite exists to pin, both of them about a SLOW server:
 *
 *  1. a send while disconnected must REPORT that it did not happen, so the
 *     caller can keep the draft and retry — the old `sendSessionDraft` returned
 *     void and swallowed the drop, which is how text went missing;
 *  2. an arriving document must carry its `rev` up to the caller, because the
 *     local arbitration cannot tell a stale replay from a new edit without it.
 */
import { asSessionId } from '@podium/model'
import { encode, type ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SocketHub, type WebSocketLike } from './socket-hub'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

function setup() {
  const sock = new FakeSocket()
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => sock,
  })
  return { sock, hub }
}

const frames = (sock: FakeSocket, type: string): Array<Record<string, unknown>> =>
  sock.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type)

const S = asSessionId('s1')

describe('sendDraftEdit', () => {
  it('sends the versioned frame and confirms it went out', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()

    expect(hub.sendDraftEdit(S, 7, 'hello world')).toBe(true)
    expect(frames(sock, 'draftEdit')).toEqual([
      { type: 'draftEdit', sessionId: S, baseRev: 7, text: 'hello world' },
    ])
  })

  // The whole point: a caller that is told `false` keeps the draft dirty and
  // re-offers it on reconnect. A silent drop here is text loss later.
  it('reports a send that could not happen while disconnected', () => {
    const { sock, hub } = setup()

    expect(hub.sendDraftEdit(S, 0, 'typed offline')).toBe(false)
    expect(frames(sock, 'draftEdit')).toEqual([])
  })

  it('carries a clear as an ordinary edit', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()

    expect(hub.sendDraftEdit(S, 3, '')).toBe(true)
    expect(frames(sock, 'draftEdit')).toEqual([
      { type: 'draftEdit', sessionId: S, baseRev: 3, text: '' },
    ])
  })
})

describe('the sessionDraft event', () => {
  it('carries the version metadata the server stamped', () => {
    const { sock, hub } = setup()
    const seen: Array<[string, string, unknown]> = []
    hub.on('sessionDraft', (sessionId, text, meta) => seen.push([sessionId, text, meta]))
    hub.connect()
    sock.open()

    sock.recv({
      type: 'sessionDraftChanged',
      sessionId: S,
      text: 'from elsewhere',
      rev: 12,
      origin: 'clientB',
      editedAt: '2026-08-14T12:00:00.000Z',
    } as ServerMessage)

    expect(seen).toEqual([
      [S, 'from elsewhere', { rev: 12, origin: 'clientB', editedAt: '2026-08-14T12:00:00.000Z' }],
    ])
  })

  // An older server stamps nothing. That must stay legible as "no rev
  // information" rather than arriving as rev 0, which would read as a document
  // older than everything and quietly lose every arbitration.
  it('passes no metadata when the server stamped none', () => {
    const { sock, hub } = setup()
    const seen: unknown[] = []
    hub.on('sessionDraft', (_sessionId, _text, meta) => seen.push(meta))
    hub.connect()
    sock.open()

    sock.recv({ type: 'sessionDraftChanged', sessionId: S, text: 'legacy' } as ServerMessage)

    expect(seen).toEqual([undefined])
  })
})
