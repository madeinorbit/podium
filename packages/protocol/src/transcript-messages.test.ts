import { describe, expect, it } from 'vitest'
import {
  ControlMessage,
  DaemonMessage,
  encode,
  parseClientMessage,
  parseControlMessage,
  parseDaemonMessage,
  parseServerMessage,
  ServerMessage,
  type TranscriptItem,
} from './messages'

const item: TranscriptItem = {
  id: 'i1',
  cursor: 'c1',
  role: 'assistant',
  text: 'hello',
}

describe('transcript read (server -> daemon)', () => {
  it('round-trips a transcriptRead control message (with anchor)', () => {
    const msg = {
      type: 'transcriptRead' as const,
      requestId: 'tr1',
      sessionId: 's1',
      anchor: 'c5',
      direction: 'before' as const,
      limit: 50,
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a transcriptRead without an anchor (initial tail)', () => {
    const msg = {
      type: 'transcriptRead' as const,
      requestId: 'tr2',
      sessionId: 's1',
      direction: 'after' as const,
      limit: 100,
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('rejects a transcriptRead with an invalid direction', () => {
    expect(() =>
      parseControlMessage(
        JSON.stringify({
          type: 'transcriptRead',
          requestId: 'tr3',
          sessionId: 's1',
          direction: 'sideways',
          limit: 10,
        }),
      ),
    ).toThrow()
  })

  it('rejects a transcriptRead with an out-of-bounds limit (negative / non-int / over max)', () => {
    for (const limit of [-1, 0, 3.7, 5000]) {
      expect(() =>
        parseControlMessage(
          JSON.stringify({
            type: 'transcriptRead',
            requestId: 'tr4',
            sessionId: 's1',
            direction: 'before',
            limit,
          }),
        ),
      ).toThrow()
    }
  })
})

describe('transcript read result (daemon -> server)', () => {
  it('round-trips a transcriptReadResult daemon message', () => {
    const msg = {
      type: 'transcriptReadResult' as const,
      requestId: 'tr1',
      sessionId: 's1',
      items: [item],
      head: 'c1',
      tail: 'c1',
      hasMore: false,
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a transcriptReadResult with head/tail omitted (empty page)', () => {
    const msg = {
      type: 'transcriptReadResult' as const,
      requestId: 'tr2',
      sessionId: 's1',
      items: [],
      hasMore: true,
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})

describe('transcript delta (daemon -> server AND server -> client)', () => {
  const msg = {
    type: 'transcriptDelta' as const,
    sessionId: 's1',
    items: [item],
    tail: 'c1',
    reset: true,
  }

  it('round-trips a transcriptDelta through the daemon union', () => {
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a transcriptDelta through the server union', () => {
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a transcriptDelta with tail/reset omitted', () => {
    const minimal = { type: 'transcriptDelta' as const, sessionId: 's1', items: [item] }
    expect(parseServerMessage(encode(minimal))).toEqual(minimal)
  })
})

describe('transcript subscribe (client -> server)', () => {
  it('round-trips a transcriptSubscribe with a since cursor', () => {
    const msg = { type: 'transcriptSubscribe' as const, sessionId: 's1', since: 'c9' }
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a transcriptSubscribe without since (full stream)', () => {
    const msg = { type: 'transcriptSubscribe' as const, sessionId: 's1' }
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a transcriptUnsubscribe', () => {
    const msg = { type: 'transcriptUnsubscribe' as const, sessionId: 's1' }
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })
})

describe('retired transcript message literals no longer parse', () => {
  it('rejects transcriptAppend in the server and daemon unions', () => {
    const raw = JSON.stringify({ type: 'transcriptAppend', sessionId: 's1', items: [] })
    expect(() => parseServerMessage(raw)).toThrow()
    expect(() => parseDaemonMessage(raw)).toThrow()
    expect(ServerMessage.safeParse(JSON.parse(raw)).success).toBe(false)
    expect(DaemonMessage.safeParse(JSON.parse(raw)).success).toBe(false)
  })

  it('rejects transcriptSnapshot in the server union', () => {
    const raw = JSON.stringify({ type: 'transcriptSnapshot', sessionId: 's1', items: [] })
    expect(() => parseServerMessage(raw)).toThrow()
    expect(ServerMessage.safeParse(JSON.parse(raw)).success).toBe(false)
  })

  it('rejects transcriptPageRequest in the control union', () => {
    const raw = JSON.stringify({
      type: 'transcriptPageRequest',
      requestId: 'r1',
      agentKind: 'claude-code',
      cwd: '/w',
      resume: { kind: 'claude-session', value: 'x' },
      fromEnd: 0,
      limit: 50,
    })
    expect(() => parseControlMessage(raw)).toThrow()
    expect(ControlMessage.safeParse(JSON.parse(raw)).success).toBe(false)
  })

  it('rejects transcriptPageResult in the daemon union', () => {
    const raw = JSON.stringify({
      type: 'transcriptPageResult',
      requestId: 'r1',
      items: [],
      hasMore: false,
    })
    expect(() => parseDaemonMessage(raw)).toThrow()
    expect(DaemonMessage.safeParse(JSON.parse(raw)).success).toBe(false)
  })

  it('rejects the old transcriptReadRequest literal in the control union', () => {
    // The old request shape carried agentKind/cwd/resume under type
    // 'transcriptReadRequest'; the unified read uses literal 'transcriptRead'.
    const raw = JSON.stringify({
      type: 'transcriptReadRequest',
      requestId: 'r1',
      agentKind: 'claude-code',
      cwd: '/w',
      resume: { kind: 'claude-session', value: 'x' },
    })
    expect(() => parseControlMessage(raw)).toThrow()
    expect(ControlMessage.safeParse(JSON.parse(raw)).success).toBe(false)
  })
})
