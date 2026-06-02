import { describe, expect, it } from 'vitest'
import {
  encode,
  parseClientMessage,
  parseControlMessage,
  parseDaemonMessage,
  parseServerMessage,
} from './messages'

describe('protocol codec', () => {
  it('round-trips a client input message', () => {
    const msg = { type: 'input', data: 'YQ==' } as const
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a server output frame', () => {
    const msg = { type: 'outputFrame', seq: 3, epoch: 1, data: 'AAA=' } as const
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })

  it('rejects an unknown client message type', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'nope' }))).toThrow()
  })

  it('rejects a resize with non-positive dimensions', () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: 'resize', cols: 0, rows: 24 })),
    ).toThrow()
  })

  it('round-trips a daemon bind message', () => {
    const msg = {
      type: 'bind',
      sessionId: 's1',
      cmd: 'claude',
      geometry: { cols: 80, rows: 24 },
    } as const
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a control redraw message', () => {
    const msg = { type: 'redraw' } as const
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseClientMessage('{bad json')).toThrow()
  })

  it('round-trips a daemon agentFrame message', () => {
    const msg = { type: 'agentFrame', seq: 7, data: 'aGVsbG8=' } as const
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})
