import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../session/registry.js'
import { Terminal } from './terminal.js'
import { adaptTerminal } from './transport.js'

const SESSION = asSessionId('terminal-transport')

/** A podium-host-shaped attachment: it holds the writer lease. */
function attached() {
  const written: string[] = []
  const attachment = {
    pid: 42,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: (dataBase64: string) => {
      written.push(Buffer.from(dataBase64, 'base64').toString('utf8'))
    },
    writeBytes: () => {},
    resize: () => {},
    dispose: () => {},
    holdsWriterLease: () => true,
    onLeaseLost: () => () => {},
  } as unknown as DurableAttachment
  const sessions = new SessionRegistry()
  const owned = sessions.ensure(SESSION)
  const terminal = Terminal.attach(attachment, owned, { onFrame: () => {} })
  owned.replaceTerminal(terminal)
  return { sessions, terminal, written }
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('the driver transport over a Terminal (POD-4785, POD-4888)', () => {
  it("lets a message's own writes past the foreign-write counter and counts the rest", () => {
    const { sessions, terminal, written } = attached()
    const transport = adaptTerminal(terminal)!
    const start = sessions.foreignWrites(SESSION)
    transport.writeBase64(b64('ship it'), 'message')
    transport.writeBase64(b64('\r'), 'message')
    expect(sessions.foreignWrites(SESSION)).toBe(start)
    transport.writeBase64(b64('\x1b'), 'control')
    transport.writeBase64(b64('1'))
    expect(sessions.foreignWrites(SESSION)).toBe(start + 2)
    expect(written).toEqual(['ship it', '\r', '\x1b', '1'])
  })

  it('reads liveness from the Terminal on every read, not once', () => {
    const { terminal } = attached()
    const transport = adaptTerminal(terminal)!
    expect(transport.live).toBe(true)
    terminal.park()
    expect(transport.live).toBe(false)
  })

  it('hands no transport for no Terminal', () => {
    expect(adaptTerminal(undefined)).toBeUndefined()
  })
})
