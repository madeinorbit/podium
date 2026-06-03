import { describe, expect, it } from 'vitest'
import {
  AgentKind,
  type ClientMessage,
  ConversationSummaryWire,
  ResumeRef,
  SessionMeta,
  encode,
  parseClientMessage,
  parseControlMessage,
  parseDaemonMessage,
  parseServerMessage,
} from './messages'

describe('shared schemas', () => {
  it('round-trips a SessionMeta (spawn origin)', () => {
    const meta = {
      sessionId: 's1',
      agentKind: 'claude-code' as const,
      title: 'fix the bug',
      cwd: '/home/u/proj',
      status: 'live' as const,
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  it('round-trips a SessionMeta (resume origin, exited)', () => {
    const meta = {
      sessionId: 's2',
      agentKind: 'codex' as const,
      title: 'old thread',
      cwd: '/w',
      status: 'exited' as const,
      exitCode: 0,
      controllerId: null,
      geometry: { cols: 100, rows: 30 },
      epoch: 2,
      clientCount: 0,
      createdAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'resume' as const, conversationId: 'conv-9' },
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  it('parses AgentKind and ResumeRef', () => {
    expect(AgentKind.parse('codex')).toBe('codex')
    expect(ResumeRef.parse({ kind: 'claude-session', value: 'abc' })).toEqual({
      kind: 'claude-session',
      value: 'abc',
    })
  })

  it('round-trips a ConversationSummaryWire with optional fields omitted', () => {
    const min = { id: 'x', agentKind: 'claude-code' as const, providerId: 'claude-code-jsonl' }
    expect(ConversationSummaryWire.parse(min)).toEqual(min)
  })
})

describe('ClientMessage', () => {
  const cases: ClientMessage[] = [
    { type: 'hello', clientId: 'c1', viewport: { cols: 80, rows: 24, dpr: 2 } },
    { type: 'attach', sessionId: 's1' },
    { type: 'detach', sessionId: 's1' },
    { type: 'input', sessionId: 's1', data: 'aGk=' },
    { type: 'resize', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'requestControl', sessionId: 's1' },
    { type: 'redrawRequest', sessionId: 's1' },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })
  it('rejects input without sessionId', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'input', data: 'x' }))).toThrow()
  })
})
