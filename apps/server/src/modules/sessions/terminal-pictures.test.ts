import { CLIENT_WIRE_VERSION } from '@podium/protocol'
/**
 * VIEWER CATCH-UP FROM THE HOST'S PICTURES — server half (POD-4912, SPEC v4 B2).
 *
 * The host puts pictures of its screen into its own output stream; the server
 * keeps, per session, the latest picture plus the bytes after it. A viewer that
 * missed anything (it attached, the pump dropped a frame to it, a reset picture
 * arrived, the controller changed, it asked for a redraw) is OWED: it gets that
 * picture, then the tail, through a pulled send sequence, and no live bytes
 * until the sequence ends. Only sessions whose last bind said `pictures` owe.
 */

import { asSessionId, asUserId, firstAdminMemberId, type Geometry } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { type SendSequenceSource, SequenceBinary } from '../../gateway/ordered-client-send'
import { SessionTerminal } from './terminal'

const SESSION = asSessionId('s-pictures')
const OWNER = asUserId(firstAdminMemberId())
const G80: Geometry = { cols: 80, rows: 24 }

type Pull = SendSequenceSource<ServerMessage>

interface Viewer extends ClientConn {
  sent: ServerMessage[]
  /** Sequences this viewer was handed and has not finished pulling. */
  pending: Pull[]
  /** Every output byte this viewer received, served or live, in order. */
  text(): string
}

const outputText = (m: ServerMessage | SequenceBinary): string | undefined => {
  if (m instanceof SequenceBinary) throw new Error('legacy viewer handed a binary frame')
  return m.type === 'outputFrame' ? Buffer.from(m.data, 'base64').toString('latin1') : undefined
}

/**
 * A legacy (JSON) viewer. `lazy` keeps every sequence it is handed for the test
 * to pull one message at a time; otherwise it drains a sequence the moment it
 * gets it, like an in-process peer.
 */
function viewer(id: string, opts: { lazy?: boolean; dropLive?: boolean } = {}): Viewer {
  const sent: ServerMessage[] = []
  const pending: Pull[] = []
  const v: Viewer = {
    id,
    principal: userClientPrincipal(id, OWNER, 'admin'),
    send: (m) => sent.push(m),
    sendStream: (m, onDrop) => {
      if (opts.dropLive) {
        onDrop?.()
        return false
      }
      sent.push(m)
      return true
    },
    sendSequence: (source) => {
      if (opts.lazy) {
        pending.push(source)
        return new Promise(() => {})
      }
      for (let m = source.next(); m !== undefined; m = source.next()) sent.push(m as ServerMessage)
      return Promise.resolve({ ok: true as const })
    },
    viewports: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: CLIENT_WIRE_VERSION,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
    pending,
    text: () => sent.map((m) => outputText(m) ?? '').join(''),
  }
  return v
}

/** Pull one message from this viewer's oldest sequence; record it as received. */
function pull(v: Viewer): string | undefined {
  const source = v.pending[0]
  if (!source) throw new Error('nothing to pull')
  const m = source.next()
  if (m === undefined) {
    v.pending.shift()
    return undefined
  }
  v.sent.push(m as ServerMessage)
  return outputText(m)
}

function terminal(geometry: Geometry = G80) {
  const toDaemon: ControlMessage[] = []
  const t = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'claude-code',
    geometry: { ...geometry },
    toDaemon: (m) => toDaemon.push(m),
  })
  return { t, toDaemon }
}

const bytes = (s: string): Buffer => Buffer.from(s, 'latin1')
const picture = (reason: 'reset' | 'cut', text: string, g: Geometry = G80) => ({
  reason,
  cols: g.cols,
  rows: g.rows,
  bytes: bytes(text),
})
const redraws = (toDaemon: ControlMessage[]) => toDaemon.filter((m) => m.type === 'redraw')
const attachedOf = (v: Viewer) =>
  v.sent.find((m): m is Extract<ServerMessage, { type: 'attached' }> => m.type === 'attached')

describe('picture-only catch-up (SPEC v4 B3, H6 accept)', () => {
  it.each([
    'normal',
    'alternate',
  ] as const)('a session without pictures attaches to live %s bytes only and never asks for a repaint', (mode) => {
    const { t, toDaemon } = terminal()
    t.setPictures(false)
    t.acceptOutput(bytes(`${mode === 'alternate' ? '\x1b[?1049h' : ''}HISTORY`), 1)
    const v = viewer('live')
    t.attachClient(v)
    expect(v.text()).toBe('')
    expect(attachedOf(v)).toMatchObject({ resumed: true, outputSeen: true })
    expect(redraws(toDaemon)).toEqual([])
    t.acceptOutput(bytes('LIVE'), 1)
    expect(v.text()).toBe('LIVE')
  })

  it('an attach before bind waits for pictures and gets exactly picture plus tail', () => {
    const { t, toDaemon } = terminal()
    const v = viewer('waiting')
    t.attachClient(v)
    t.acceptOutput(bytes('BEFORE PICTURE'), 1)
    expect(v.text()).toBe('')
    expect(redraws(toDaemon)).toEqual([])
    t.acceptPicture(picture('cut', '<PICTURE>'))
    t.acceptOutput(bytes('TAIL'), 1)
    expect(v.text()).toBe('')
    t.setPictures(true)
    expect(v.text()).toBe('<PICTURE>TAIL')
    expect(attachedOf(v)).toMatchObject({ resumed: true })
  })

  it('a bind without pictures releases a waiting viewer to live bytes without repaint', () => {
    const { t, toDaemon } = terminal()
    const v = viewer('waiting')
    t.attachClient(v)
    t.acceptOutput(bytes('BEFORE BIND'), 1)
    t.setPictures(false)
    expect(v.text()).toBe('')
    expect(redraws(toDaemon)).toEqual([])
    t.acceptOutput(bytes('LIVE'), 1)
    expect(v.text()).toBe('LIVE')
  })

  it('disabling pictures releases an owed viewer without the old attach redraw', () => {
    const { t, toDaemon } = terminal()
    t.setPictures(true)
    const v = viewer('owed')
    t.attachClient(v)
    t.setPictures(false)
    expect(redraws(toDaemon)).toEqual([])
    t.acceptOutput(bytes('LIVE'), 1)
    expect(v.text()).toBe('LIVE')
  })
})

describe('a pictures session serves an owed viewer the picture and the tail', () => {
  it('a cold attach gets exactly the picture then the tail, never an older byte', () => {
    const { t, toDaemon } = terminal()
    t.setPictures(true)
    t.acceptOutput(bytes('OLD-1 '), 1)
    t.acceptPicture(picture('cut', '<PIC>'))
    t.acceptOutput(bytes('tail-a '), 1)
    t.acceptOutput(bytes('tail-b'), 1)
    const v = viewer('c1')
    t.attachClient(v)
    expect(attachedOf(v)).toMatchObject({ resumed: true })
    expect(v.text()).toBe('<PIC>tail-a tail-b')
    // No legacy repaint: the picture is the catch-up.
    expect(redraws(toDaemon)).toEqual([])
  })

  it('serves a binary viewer binary envelopes through the pulled sequence', async () => {
    const { decodeBinaryEnvelope, PtyOutputBinaryMetadata, CAP_TERMINAL_OUTPUT_BINARY_V1 } =
      await import('@podium/protocol')
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<PIC>'))
    t.acceptOutput(bytes('after'), 1)
    const frames: Uint8Array[] = []
    const v = viewer('bin')
    v.caps.add(CAP_TERMINAL_OUTPUT_BINARY_V1)
    v.sendBinary = (b) => frames.push(b)
    v.sendBinaryStream = (b) => {
      frames.push(b)
      return true
    }
    v.sendSequence = (source) => {
      for (let m = source.next(); m !== undefined; m = source.next()) {
        if (!(m instanceof SequenceBinary)) throw new Error('binary viewer got JSON output')
        frames.push(m.bytes)
      }
      return Promise.resolve({ ok: true as const })
    }
    t.attachClient(v)
    const decoded = frames.map((f) => decodeBinaryEnvelope(f, PtyOutputBinaryMetadata))
    expect(decoded.map((d) => Buffer.from(d.payload).toString('latin1'))).toEqual([
      '<PIC>',
      'after',
    ])
    expect(decoded.every((d) => d.metadata.epoch === t.epoch)).toBe(true)
    // Monotonic: the picture has its own place in the stream.
    const [pictureFrame, tailFrame] = decoded
    if (!pictureFrame || !tailFrame) throw new Error('expected two frames')
    expect(pictureFrame.metadata.seq).toBeLessThan(tailFrame.metadata.seq)
  })

  it('serves only once the picture is at the session geometry; the report serves it', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<BIG>', { cols: 120, rows: 40 }))
    const v = viewer('c1')
    t.attachClient(v)
    expect(v.text()).toBe('')
    t.applyDaemonGeometry({ cols: 120, rows: 40 })
    expect(v.text()).toBe('<BIG>')
  })

  it('an owed viewer gets no live bytes; bytes that arrive mid-serve reach it exactly once', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P>'))
    const v = viewer('c1', { lazy: true })
    t.attachClient(v)
    expect(pull(v)).toBe('<P>')
    t.acceptOutput(bytes('A'), 1)
    // Still owed: the live fan-out skips it, the tail carries it.
    expect(v.text()).toBe('<P>')
    expect(pull(v)).toBe('A')
    t.acceptOutput(bytes('B'), 1)
    expect(pull(v)).toBe('B')
    // The source ends and owed clears in the same call (E5): nothing between.
    expect(pull(v)).toBeUndefined()
    t.acceptOutput(bytes('C'), 1)
    expect(v.text()).toBe('<P>ABC')
  })

  it('a serve in flight reads its tail by offset across a cut', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P1>'))
    const v = viewer('c1', { lazy: true })
    t.attachClient(v)
    expect(pull(v)).toBe('<P1>')
    t.acceptOutput(bytes('A'), 1)
    t.acceptPicture(picture('cut', '<P2>'))
    t.acceptOutput(bytes('B'), 1)
    // Not the cut: the rest of this serve's own tail, from where it was.
    while (v.pending.length > 0) pull(v)
    expect(v.text()).toBe('<P1>AB')
    t.acceptOutput(bytes('C'), 1)
    expect(v.text()).toBe('<P1>ABC')
  })
})

describe('what makes a viewer owed', () => {
  it('a reset picture owes every viewer; a cut owes none', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P1>'))
    const a = viewer('a')
    const b = viewer('b')
    t.attachClient(a)
    t.attachClient(b)
    t.acceptOutput(bytes('x'), 1)
    t.acceptPicture(picture('cut', '<CUT>'))
    t.acceptOutput(bytes('y'), 1)
    expect(a.text()).toBe('<P1>xy')
    expect(b.text()).toBe('<P1>xy')
    t.acceptPicture(picture('reset', '<P2>'))
    expect(a.text()).toBe('<P1>xy<P2>')
    expect(b.text()).toBe('<P1>xy<P2>')
  })

  it('a dropped lossy frame owes that viewer only, and catches it up exactly once', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P>'))
    const steady = viewer('steady')
    const slow = viewer('slow')
    t.attachClient(steady)
    t.attachClient(slow)
    let dropNext = true
    slow.sendStream = (m, onDrop) => {
      if (dropNext) {
        dropNext = false
        onDrop?.()
        return false
      }
      slow.sent.push(m)
      return true
    }
    t.acceptOutput(bytes('lost'), 1)
    // The drop owed it, and it was served at once: the picture, then the tail,
    // which holds the very bytes it lost.
    expect(slow.text()).toBe('<P><P>lost')
    t.acceptOutput(bytes('+'), 1)
    expect(slow.text()).toBe('<P><P>lost+')
    expect(steady.text()).toBe('<P>lost+')
  })

  it('a controller change owes every viewer', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P>'))
    const a = viewer('a')
    const b = viewer('b')
    t.attachClient(a)
    t.attachClient(b)
    const epoch = t.epoch
    t.requestControl('b')
    expect(t.epoch).toBe(epoch + 1)
    expect(a.text()).toBe('<P><P>')
    expect(b.text()).toBe('<P><P>')
  })

  it("a spectator's redraw re-owes it and never reaches the daemon; the controller's sends Ctrl-L too", () => {
    const { t, toDaemon } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P>'))
    const ctl = viewer('ctl')
    const spec = viewer('spec')
    t.attachClient(ctl)
    t.attachClient(spec)
    expect(t.controllerId).toBe('ctl')
    t.redrawRequest('spec')
    expect(spec.text()).toBe('<P><P>')
    expect(ctl.text()).toBe('<P>')
    expect(redraws(toDaemon)).toEqual([])
    t.redrawRequest('ctl')
    expect(ctl.text()).toBe('<P><P>')
    expect(redraws(toDaemon)).toEqual([{ type: 'redraw', sessionId: SESSION, hard: true }])
  })

  it("a spectator's redraw on a session without pictures does not reach the daemon either", () => {
    const { t, toDaemon } = terminal()
    t.setPictures(false)
    const ctl = viewer('ctl')
    const spec = viewer('spec')
    t.attachClient(ctl)
    t.attachClient(spec)
    toDaemon.length = 0
    t.redrawRequest('spec')
    expect(redraws(toDaemon)).toEqual([])
    t.redrawRequest('ctl')
    expect(redraws(toDaemon)).toEqual([{ type: 'redraw', sessionId: SESSION, hard: true }])
  })
})

describe('sessions without pictures, and the first bind', () => {
  it('a bind without pictures releases owed viewers to live bytes only', () => {
    const { t, toDaemon } = terminal()
    t.setPictures(true)
    const v = viewer('c1')
    t.attachClient(v)
    expect(v.text()).toBe('')
    t.setPictures(false)
    expect(redraws(toDaemon)).toEqual([])
    t.acceptOutput(bytes('live'), 1)
    expect(v.text()).toBe('live')
  })

  it('an attach waits for the first bind and its reset picture', () => {
    const { t } = terminal()
    const v = viewer('c1')
    t.attachClient(v)
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P>'))
    expect(v.text()).toBe('<P>')
  })

  it('pictures are not activity', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptOutput(bytes('x'), 1)
    t.clearActivityDirty()
    const count = t.outputCount
    const at = t.lastOutputAtMs
    t.acceptPicture(picture('cut', '<P>'))
    t.acceptPicture(picture('reset', '<P>'))
    expect(t.outputCount).toBe(count)
    expect(t.lastOutputAtMs).toBe(at)
    expect(t.activityDirty).toBe(false)
  })

  it('a session without pictures never owes and never caches', () => {
    const { t } = terminal()
    t.setPictures(false)
    t.acceptOutput(bytes('shell line\r\n'), 1)
    const v = viewer('c1')
    t.attachClient(v)
    expect(attachedOf(v)?.resumed).toBe(true)
    expect(v.text()).toBe('')
  })
})

describe('bounds: the tail cap, the detach, the stale-owed nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('past max(256 KiB, 2x the picture) the cache is dropped; a serve that lost its tail is re-owed', () => {
    const { t } = terminal()
    t.setPictures(true)
    t.acceptPicture(picture('reset', '<P1>'))
    const v = viewer('c1', { lazy: true })
    t.attachClient(v)
    expect(pull(v)).toBe('<P1>')
    t.acceptOutput(Buffer.alloc(200 * 1024, 0x61), 1)
    t.acceptOutput(Buffer.alloc(100 * 1024, 0x62), 1)
    // The tail passed 256 KiB: the cache is gone and so is this serve's tail.
    expect(pull(v)).toBeUndefined()
    const fresh = viewer('c2')
    t.attachClient(fresh)
    expect(fresh.text()).toBe('')
    // Still owed, both of them: the next reset picture serves them.
    t.acceptPicture(picture('reset', '<P2>'))
    for (const pending = v.pending; pending.length > 0; ) pull(v)
    expect(v.text().endsWith('<P2>')).toBe(true)
    expect(fresh.text()).toBe('<P2>')
  })

  it('the cap is twice a large picture', () => {
    const { t } = terminal()
    t.setPictures(true)
    const big = 'P'.repeat(300 * 1024)
    t.acceptPicture(picture('reset', big))
    t.acceptOutput(Buffer.alloc(400 * 1024, 0x61), 1)
    const v = viewer('c1')
    t.attachClient(v)
    expect(v.text().length).toBe(big.length + 400 * 1024)
  })

  it('a viewer owed with nothing to serve nudges the daemon at most once a second', () => {
    const { t, toDaemon } = terminal()
    t.setPictures(true)
    const v = viewer('c1')
    t.attachClient(v)
    expect(redraws(toDaemon)).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(redraws(toDaemon)).toEqual([
      { type: 'redraw', sessionId: SESSION, replayRequired: true },
    ])
    vi.advanceTimersByTime(500)
    expect(redraws(toDaemon)).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(redraws(toDaemon)).toHaveLength(2)
    t.acceptPicture(picture('reset', '<P>'))
    expect(v.text()).toBe('<P>')
    vi.advanceTimersByTime(5000)
    expect(redraws(toDaemon)).toHaveLength(2)
  })

  it('a detach drops a live session’s cache but keeps an exited session’s', () => {
    const live = terminal()
    live.t.setPictures(true)
    live.t.acceptPicture(picture('reset', '<LIVE>'))
    live.t.linkDetached()
    const a = viewer('a')
    live.t.attachClient(a)
    expect(a.text()).not.toContain('<LIVE>')
    // Until a daemon binds again the viewer waits; nothing nudges a daemon
    // that is gone.
    vi.advanceTimersByTime(5000)
    expect(redraws(live.toDaemon)).toEqual([])

    const exited = terminal()
    exited.t.setPictures(true)
    exited.t.acceptPicture(picture('reset', '<LAST>'))
    exited.t.stopOutput()
    exited.t.linkDetached()
    const b = viewer('b')
    exited.t.attachClient(b)
    expect(b.text()).toBe('<LAST>')
  })
})
