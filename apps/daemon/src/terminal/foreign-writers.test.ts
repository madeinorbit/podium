/**
 * EVERY CONTROL-PATH WRITER, THROUGH ITS REAL WRITE PATH, IS ONE COUNTED
 * FOREIGN WRITE (POD-4888, spec §5.3). The writers here are the ones reached
 * from control frames: a person's keystrokes (the base64 frame and the binary
 * frame), an automation input frame for a session with no driver, and the
 * redraw button's Ctrl-L. The driver-owned writers (menu answers, the
 * interrupt key, a message's own paste/Enter/retries) are pinned in
 * `runtime/terminal-driver.test.ts`, Draft Sync in `composer-sync.test.ts` and
 * the Ctrl-U clear in `session-observers.test.ts`.
 */

import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { dispatchNativeInputBytes } from '../control/native-terminal-input.js'
import { sessionHandlers } from '../control/session'
import { attachTestTerminal, testSessions } from '../session/testing.js'
import { writeHeadedInput } from './headed-input.js'

const SESSION = asSessionId('foreign-writers')

function world() {
  const written: string[] = []
  const attachment = {
    pid: 7,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: (dataBase64: string) => written.push(Buffer.from(dataBase64, 'base64').toString('utf8')),
    writeBytes: (data: Uint8Array) => written.push(Buffer.from(data).toString('utf8')),
    resize: () => {},
    dispose: () => {},
    holdsWriterLease: () => true,
    onLeaseLost: () => () => {},
  } as unknown as DurableAttachment
  const sessions = testSessions()
  attachTestTerminal({ sessions }, SESSION, attachment)
  const ctx = {
    sessions,
    observers: { recordInputOrigin: () => {} },
    composerEngine: { onInputByte: () => {} },
    outputScheduler: { flushNow: () => {}, enqueue: () => {} },
  } as unknown as DaemonContext
  const count = () => sessions.foreignWrites(SESSION)
  return { ctx, sessions, written, count }
}

describe('control-path writers are counted foreign writes (POD-4888)', () => {
  it('a person’s keystrokes on the base64 input frame: one count per frame', () => {
    const { ctx, written, count } = world()
    const start = count()
    const type = (text: string) =>
      sessionHandlers.input(ctx, {
        type: 'input',
        sessionId: SESSION,
        inputOrigin: 'human',
        data: Buffer.from(text).toString('base64'),
      })
    type('h')
    expect(count()).toBe(start + 1)
    type('ello')
    type('\r')
    expect(count()).toBe(start + 3)
    expect(written).toEqual(['h', 'ello', '\r'])
  })

  it('a person’s keystrokes on the binary input frame', () => {
    const { ctx, written, count } = world()
    const start = count()
    dispatchNativeInputBytes(ctx, { sessionId: SESSION, inputOrigin: 'human' }, Buffer.from('ab\r'))
    expect(count()).toBe(start + 1)
    expect(written).toEqual(['ab\r'])
  })

  it('an automation input frame for a session with no driver', () => {
    const { ctx, written, count } = world()
    const start = count()
    sessionHandlers.input(ctx, {
      type: 'input',
      sessionId: SESSION,
      inputOrigin: 'controller',
      data: Buffer.from('x').toString('base64'),
    })
    expect(count()).toBe(start + 1)
    expect(written).toEqual(['x'])
  })

  it('the redraw button’s Ctrl-L', () => {
    const { ctx, written, count } = world()
    const start = count()
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION, hard: true })
    expect(count()).toBe(start + 1)
    expect(written).toEqual(['\x0c'])
    // A soft redraw never touches the program, so it is not a write at all.
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION })
    expect(count()).toBe(start + 1)
  })

  it('the daemon’s own headed keystrokes (Draft Sync, the Ctrl-U clear) share one counted path', () => {
    const { sessions, written, count } = world()
    const start = count()
    writeHeadedInput(sessions, SESSION, '\x15\x15')
    expect(count()).toBe(start + 1)
    expect(written).toEqual(['\x15\x15'])
  })
})
