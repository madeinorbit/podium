import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../session/registry.js'
import { MESSAGE_WRITE, TYPING_MARKS_MAX } from './foreign-writes.js'
import { Terminal } from './terminal.js'

const SESSION = asSessionId('foreign-writes')

interface FakeAttachment extends DurableAttachment {
  written: string[]
  loseLease(): void
}

/**
 * An attachment shaped like the podium-host one (a writer lease it can lose)
 * or, with `lease: 'none'`, one that holds no writer lease (another client may
 * be writing).
 */
function fakeAttachment(lease: 'held' | 'none' = 'held'): FakeAttachment {
  const written: string[] = []
  let held = lease === 'held'
  const lost = new Set<() => void>()
  const base = {
    pid: 42,
    written,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: (dataBase64: string) => {
      written.push(Buffer.from(dataBase64, 'base64').toString('utf8'))
    },
    writeBytes: (data: Uint8Array) => {
      written.push(Buffer.from(data).toString('utf8'))
    },
    resize: () => {},
    dispose: () => {},
    loseLease: () => {
      held = false
      for (const cb of [...lost]) cb()
    },
  }
  if (lease === 'none') return base as unknown as FakeAttachment
  return {
    ...base,
    holdsWriterLease: () => held,
    onLeaseLost: (cb: () => void) => {
      lost.add(cb)
      return () => lost.delete(cb)
    },
  } as unknown as FakeAttachment
}

function attached(lease: 'held' | 'none' = 'held') {
  const sessions = new SessionRegistry()
  const owned = sessions.ensure(SESSION)
  const attachment = fakeAttachment(lease)
  const terminal = Terminal.attach(attachment, owned, { onFrame: () => {} })
  owned.replaceTerminal(terminal)
  return { sessions, owned, attachment, terminal }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('the foreign-write counter under the Terminal write call (POD-4888)', () => {
  it('counts every write that is not the message’s own, once per write', () => {
    const { sessions, attachment, terminal } = attached()
    const start = sessions.foreignWrites(SESSION)

    terminal.write(bytes('a'))
    expect(sessions.foreignWrites(SESSION)).toBe(start + 1)
    // Many bytes in one write are one write; so is a lone Enter.
    terminal.write(bytes('hello world\r'))
    terminal.writeBase64(base64('\r'))
    expect(sessions.foreignWrites(SESSION)).toBe(start + 3)
    expect(attachment.written).toEqual(['a', 'hello world\r', '\r'])
  })

  it('lets the message’s own writes through uncounted, on both write calls', () => {
    const { sessions, attachment, terminal } = attached()
    const start = sessions.foreignWrites(SESSION)

    terminal.writeBase64(base64('\u001b[200~hi\u001b[201~'), MESSAGE_WRITE)
    terminal.writeBase64(base64('\r'), MESSAGE_WRITE)
    terminal.write(bytes('\r'), MESSAGE_WRITE)
    expect(sessions.foreignWrites(SESSION)).toBe(start)
    // Uncounted is not unwritten.
    expect(attachment.written).toHaveLength(3)
  })

  it('counts a lost writer lease, and an unchanged count stops being trustworthy', () => {
    const { sessions, attachment } = attached()
    expect(sessions.orderTrustworthy(SESSION)).toBe(true)
    const start = sessions.foreignWrites(SESSION)

    attachment.loseLease()
    expect(sessions.foreignWrites(SESSION)).toBe(start + 1)
    expect(sessions.orderTrustworthy(SESSION)).toBe(false)
  })

  it('an attachment without the writer lease is never order-trustworthy', () => {
    const { sessions } = attached('none')
    expect(sessions.orderTrustworthy(SESSION)).toBe(false)
  })

  it('a session with no Terminal is not order-trustworthy, and parking counts', () => {
    const { sessions, owned } = attached()
    const start = sessions.foreignWrites(SESSION)
    owned.park()
    // While parked anyone may take the surface; the gap is counted.
    expect(sessions.foreignWrites(SESSION)).toBe(start + 1)
    expect(sessions.orderTrustworthy(SESSION)).toBe(false)
    expect(sessions.orderTrustworthy(asSessionId('never-seen'))).toBe(false)
    expect(sessions.foreignWrites(asSessionId('never-seen'))).toBe(0)
  })

  it('attaching counts, and a replaced predecessor does not blind its successor', () => {
    const { sessions, owned } = attached()
    const start = sessions.foreignWrites(SESSION)
    const next = Terminal.attach(fakeAttachment(), owned, { onFrame: () => {} })
    owned.replaceTerminal(next)
    // The successor attached (+1) and then the predecessor was parked (+1).
    expect(sessions.foreignWrites(SESSION)).toBe(start + 2)
    expect(sessions.orderTrustworthy(SESSION)).toBe(true)
  })

  it('a parked Terminal’s lease callback is unwired', () => {
    const { sessions, owned, attachment } = attached()
    owned.park()
    const start = sessions.foreignWrites(SESSION)
    attachment.loseLease()
    expect(sessions.foreignWrites(SESSION)).toBe(start)
  })

  it('a message snapshots the count when its typing starts, and reads it later', () => {
    const { sessions, owned, terminal } = attached()
    const counter = owned.foreignWrites
    terminal.write(bytes('x'))
    counter.markTyping('msg-1')
    const mark = counter.typingMark('msg-1')
    expect(mark).toBe(sessions.foreignWrites(SESSION))
    terminal.writeBase64(base64('\u001b[200~hi\u001b[201~'), MESSAGE_WRITE)
    expect(sessions.foreignWrites(SESSION)).toBe(mark)
    terminal.write(bytes('y'))
    expect(sessions.foreignWrites(SESSION)).toBe((mark ?? 0) + 1)
    expect(counter.typingMark('msg-1')).toBe(mark)
    expect(counter.typingMark('unknown')).toBeUndefined()
  })

  it('keeps a bounded number of typing marks, dropping the oldest', () => {
    const { owned } = attached()
    const counter = owned.foreignWrites
    for (let i = 0; i <= TYPING_MARKS_MAX; i++) counter.markTyping(`m-${i}`)
    expect(counter.typingMark('m-0')).toBeUndefined()
    expect(counter.typingMark('m-1')).toBeDefined()
    expect(counter.typingMark(`m-${TYPING_MARKS_MAX}`)).toBeDefined()
  })

  it('the counter lives on the session entry: it survives park and reattach', () => {
    const { sessions, owned, terminal } = attached()
    terminal.write(bytes('a'))
    const before = sessions.foreignWrites(SESSION)
    owned.park()
    const again = Terminal.attach(fakeAttachment(), owned, { onFrame: () => {} })
    owned.replaceTerminal(again)
    expect(sessions.foreignWrites(SESSION)).toBe(before + 2)
    expect(sessions.orderTrustworthy(SESSION)).toBe(true)
  })
})
