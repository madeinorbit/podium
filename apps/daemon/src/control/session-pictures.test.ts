/**
 * THE HOST'S PICTURES ON THE DAEMON'S ITEM PATH (POD-4912, SPEC v4 B2).
 *
 * A picture travels in order with DATA from the host connection to the output
 * scheduler, and skips every per-frame side effect (N5): frame counting, the
 * first-output marker, observers, the session screen and the composer. The
 * only exception is the SEED: the first reset picture after attaching at the
 * tail rebuilds the session screen and the composer. After every bind it sends,
 * the daemon asks a screen host for a picture, and the bind says `pictures`
 * when the server accepted terminal.picture.v1. A redraw on such a session is
 * a picture request (plus Ctrl-L when hard); an old server keeps today's
 * redraw branches.
 */

import { asSessionId } from '@podium/model'
import type { AgentFrame, AgentPicture, DurableAttachment } from '@podium/process/screen'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { testSessions } from '../session/testing.js'
import { sessionScreenFor } from '../session-screens'
import type { DaemonContext } from './context'
import { sendBind, sessionHandlers, wireBridge } from './session'

const SESSION = asSessionId('33333333-3333-4333-8333-333333333333')

/** A host attachment the test drives: DATA and pictures, in one ordered stream. */
function hostAttachment(opts: { screen: boolean; atTail: boolean }) {
  const frames = new Set<(f: AgentFrame) => void>()
  const pictures = new Set<(p: AgentPicture) => void>()
  const log: string[] = []
  let seq = 0
  const attachment = {
    pid: 99,
    attachedAtTail: opts.atTail,
    onFrame: (cb: (f: AgentFrame) => void) => {
      frames.add(cb)
      return () => frames.delete(cb)
    },
    onPicture: (cb: (p: AgentPicture) => void) => {
      pictures.add(cb)
      return () => pictures.delete(cb)
    },
    onTitle: () => () => {},
    onExit: () => () => {},
    write: vi.fn(),
    writeBytes: vi.fn(),
    resize: vi.fn(),
    size: () => ({ cols: 80, rows: 24 }),
    onSize: () => () => {},
    keepsScreen: () => opts.screen,
    requestPicture: vi.fn(() => {
      log.push('request')
      return opts.screen
    }),
    replay: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
  return {
    attachment: attachment as unknown as DurableAttachment,
    raw: attachment,
    log,
    data(text: string) {
      const frame = { seq: seq++, data: Buffer.from(text, 'latin1') }
      for (const cb of [...frames]) cb(frame)
    },
    picture(reason: AgentPicture['reason'], text: string) {
      const p = { reason, cols: 80, rows: 24, bytes: Buffer.from(text, 'latin1') }
      for (const cb of [...pictures]) cb(p)
    },
  }
}

function world(opts: { accepted: boolean }) {
  const order: string[] = []
  const sent: DaemonMessage[] = []
  const scheduled: string[] = []
  const observed: string[] = []
  const composed: string[] = []
  const ctx = {
    sessions: testSessions(),
    picturesAccepted: () => opts.accepted,
    send: (m: DaemonMessage) => {
      sent.push(m)
      order.push(m.type)
    },
    outputScheduler: {
      enqueue: (_id: unknown, data: Uint8Array) => scheduled.push(`data:${Buffer.from(data).toString('latin1')}`),
      enqueuePicture: (_id: unknown, p: AgentPicture) =>
        scheduled.push(`picture:${p.reason}:${Buffer.from(p.bytes).toString('latin1')}`),
      flushNow: vi.fn(),
      remove: vi.fn(),
      setPriority: vi.fn(),
      priorityOf: () => 1,
    },
    observers: {
      onFrame: (_id: unknown, data: Uint8Array) => observed.push(Buffer.from(data).toString('latin1')),
      onResize: () => {},
      clearSession: () => {},
    },
    composerEngine: {
      has: () => true,
      onData: (_id: unknown, data: Uint8Array) => composed.push(Buffer.from(data).toString('latin1')),
      onResize: () => {},
      detach: () => {},
    },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
  } as unknown as DaemonContext
  return { ctx, sent, order, scheduled, observed, composed }
}

async function screenText(ctx: DaemonContext): Promise<string> {
  const screen = sessionScreenFor(ctx, SESSION)?.screen
  await screen?.flush()
  return (screen?.lines(false) ?? []).join('\n')
}

describe('the item path', () => {
  it('a picture reaches the scheduler in order with DATA and skips every per-frame side effect', async () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: false })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    host.data('one ')
    host.picture('cut', 'CUTPICTURE')
    host.data('two')
    expect(w.scheduled).toEqual(['data:one ', 'picture:cut:CUTPICTURE', 'data:two'])
    // Observers and the composer saw the bytes only.
    expect(w.observed).toEqual(['one ', 'two'])
    expect(w.composed).toEqual(['one ', 'two'])
    expect(await screenText(w.ctx)).not.toContain('CUTPICTURE')
  })

  it('the first reset picture after attaching at the tail seeds the screen and composer; later ones do not', async () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: true })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    host.data('gap')
    // A cut is not a seed: only a reset answers the request the bind makes.
    host.picture('cut', '\x1bcNOT-A-SEED')
    host.picture('reset', '\x1bc\x1b[HSEEDED SCREEN')
    host.data(' then live')
    host.picture('reset', '\x1bc\x1b[HSECOND RESET')
    expect(await screenText(w.ctx)).toContain('SEEDED SCREEN then live')
    expect(await screenText(w.ctx)).not.toContain('SECOND RESET')
    expect(w.composed).toEqual(['gap', '\x1bc\x1b[HSEEDED SCREEN', ' then live'])
    expect(w.observed).toEqual(['gap', ' then live'])
  })

  it('an attachment that did not start at the tail is never seeded', async () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: false })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    host.data('from the start')
    host.picture('reset', '\x1bc\x1b[HPICTURE')
    expect(await screenText(w.ctx)).toContain('from the start')
    expect(await screenText(w.ctx)).not.toContain('PICTURE')
  })
})

describe('bind and request', () => {
  const facts = { sessionId: SESSION, cmd: 'claude', cwd: '/w', agentKind: 'claude-code' as const }

  it('a bind on a picture link says pictures and is followed by a picture request', () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: true })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    w.order.length = 0
    host.log.length = 0
    const mark = w.order
    host.raw.requestPicture.mockImplementation(() => {
      mark.push('request')
      return true
    })
    sendBind(w.ctx, facts)
    expect(w.sent.at(-1)).toMatchObject({ type: 'bind', pictures: true })
    expect(w.order).toEqual(['bind', 'request'])
  })

  it('an old server gets a bind without pictures and no request', () => {
    const w = world({ accepted: false })
    const host = hostAttachment({ screen: true, atTail: true })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    sendBind(w.ctx, facts)
    expect(w.sent.at(-1)).toMatchObject({ type: 'bind' })
    expect(w.sent.at(-1)).not.toHaveProperty('pictures')
    expect(host.raw.requestPicture).not.toHaveBeenCalled()
  })

  it('a C host binds without pictures and is never asked', () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: false, atTail: true })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    sendBind(w.ctx, facts)
    expect(w.sent.at(-1)).not.toHaveProperty('pictures')
    expect(host.raw.requestPicture).not.toHaveBeenCalled()
  })

  it('the birth report says pictures on a picture link', () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: true })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    expect(w.sent.find((m) => m.type === 'geometryApplied')).toMatchObject({
      birth: true,
      pictures: true,
    })
  })
})

describe('a redraw on a picture session', () => {
  it('replayRequired asks the host for a picture instead of a snapshot or ring replay', () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: false })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    host.data('\x1b[?1049h\x1b[HALT SCREEN')
    w.scheduled.length = 0
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(host.raw.requestPicture).toHaveBeenCalledOnce()
    expect(w.scheduled).toEqual([])
    expect(host.raw.replay).not.toHaveBeenCalled()
    expect(host.raw.writeBytes).not.toHaveBeenCalled()
  })

  it('hard sends exactly one Ctrl-L and asks for nothing else', () => {
    const w = world({ accepted: true })
    const host = hostAttachment({ screen: true, atTail: false })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION, hard: true })
    expect(host.raw.writeBytes).toHaveBeenCalledOnce()
    expect([...(host.raw.writeBytes.mock.calls[0]?.[0] as Uint8Array)]).toEqual([0x0c])
    expect(host.raw.requestPicture).not.toHaveBeenCalled()
  })

  it('an old server keeps the snapshot branch', async () => {
    const w = world({ accepted: false })
    const host = hostAttachment({ screen: true, atTail: false })
    wireBridge(w.ctx, SESSION, host.attachment, 'claude-code', 'label')
    host.data('\x1b[?1049h\x1b[HALT SCREEN')
    await sessionScreenFor(w.ctx, SESSION)?.screen.flush()
    w.scheduled.length = 0
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(host.raw.requestPicture).not.toHaveBeenCalled()
    expect(w.scheduled.join('')).toContain('ALT SCREEN')
  })
})
