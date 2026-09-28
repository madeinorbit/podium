import { describe, expect, it } from 'vitest'
import {
  encodeDaemonMessage as encode,
  parseControlMessage,
  parseDaemonMessage,
} from '../daemon'
import {
  CodexCompleteRequestMessage,
  CodexCompleteResultMessage,
  type CodexLlmMessageWire,
} from './codex'

/**
 * Server-side LLM over a catalog Codex login (POD-4750): the new daemon
 * request/reply frames. Additive by construction — appended at the END of both
 * unions — so an older frame still parses and an older daemon's silence falls
 * back to the server's deadline message rather than a dropped frame.
 */
describe('codex frames (POD-4750)', () => {
  const messages: CodexLlmMessageWire[] = [
    { role: 'system', content: 'You are an orchestrator.' },
    { role: 'user', content: 'status please' },
    {
      role: 'assistant',
      content: 'checking',
      toolCalls: [{ id: 'c1', name: 'git', arguments: '{}' }],
    },
    { role: 'tool', content: 'clean', toolCallId: 'c1', name: 'git' },
  ]

  it('round-trips a codexCompleteRequest through the ControlMessage union', () => {
    const msg = {
      type: 'codexCompleteRequest' as const,
      requestId: 'cc-1',
      model: 'gpt-5.5',
      messages,
      tools: [{ name: 'git', description: 'run git', parameters: { type: 'object' } }],
      effort: 'medium' as const,
    }
    expect(CodexCompleteRequestMessage.parse(msg)).toEqual(msg)
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips success and failure codexCompleteResults through DaemonMessage', () => {
    const ok = {
      type: 'codexCompleteResult' as const,
      requestId: 'cc-1',
      ok: true as const,
      text: 'all clean',
      toolCalls: [],
    }
    expect(CodexCompleteResultMessage.parse(ok)).toEqual(ok)
    expect(parseDaemonMessage(encode(ok))).toEqual(ok)
    const failed = {
      type: 'codexCompleteResult' as const,
      requestId: 'cc-2',
      ok: false as const,
      error: 'Codex is not logged in on this machine — run `codex login`.',
    }
    expect(parseDaemonMessage(encode(failed))).toEqual(failed)
  })

  it('an OLDER frame (one that predates these arms) still parses', () => {
    // The wire-compatibility rule: new arms are additive, so a frame written
    // before POD-4750 parses exactly as before — widening the parser never
    // reinterprets old bytes.
    const older = { type: 'modelProbeRequest' as const, requestId: 'mp-9' }
    expect(parseControlMessage(encode(older))).toEqual(older)
    const olderReply = {
      type: 'modelProbeResult' as const,
      requestId: 'mp-9',
      byAgent: {},
    }
    expect(parseDaemonMessage(encode(olderReply))).toEqual(olderReply)
  })

  it('a newer request carrying an unknown extra field still parses (strips it)', () => {
    // Zod strips unknown keys by default: a future field rides without
    // breaking this build's parser.
    const base = {
      type: 'codexCompleteRequest' as const,
      requestId: 'cc-3',
      model: 'gpt-5.5',
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [],
      effort: 'low' as const,
    }
    const msg = { ...base, futureField: 'ignored' }
    const parsed = parseControlMessage(encode(msg))
    expect(parsed.type).toBe('codexCompleteRequest')
    expect('futureField' in parsed).toBe(false)
  })
})
