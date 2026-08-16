import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createGrokAcpClient, type GrokAcpTransport } from './client.js'
import { grokPermissionAction, grokPermissionAsk } from './map.js'
import { type GrokAcpFrame, GrokAcpPromptResult, parseGrokAcpSessionUpdate } from './protocol.js'
import { gateGrokVersion, parseGrokVersion, supportsGrokAcpDriver } from './version.js'

class TestTransport implements GrokAcpTransport {
  writes: string[] = []
  handler: { line(line: string): void; closed(): void } | undefined
  write(line: string): void {
    this.writes.push(line)
  }
  onLine(handler: { line(line: string): void; closed(): void }): void {
    this.handler = handler
  }
  close(): void {}
  receive(frame: unknown): void {
    this.handler?.line(JSON.stringify(frame))
  }
}

describe('Grok ACP protocol pins', () => {
  it('declares both filesystem callbacks false during initialize', async () => {
    const transport = new TestTransport()
    const client = createGrokAcpClient({
      transport,
      onNotification() {},
      onServerRequest() {},
    })
    const pending = client.initialize()
    const initialize = JSON.parse(transport.writes[0] ?? '{}')
    expect(initialize.params.clientCapabilities.fs).toEqual({
      readTextFile: false,
      writeTextFile: false,
    })
    transport.receive({
      jsonrpc: '2.0',
      id: initialize.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    })
    await expect(pending).resolves.toMatchObject({ protocolVersion: 1 })
  })

  it('takes the durable cursor from _meta.eventId on either update method', () => {
    for (const method of ['session/update', '_x.ai/session/update'] as const) {
      const parsed = parseGrokAcpSessionUpdate({
        jsonrpc: '2.0',
        method,
        params: {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } },
          _meta: { eventId: 's1-42', agentTimestampMs: 123 },
        },
      } as GrokAcpFrame)
      expect(parsed?.params._meta?.eventId).toBe('s1-42')
    }
  })

  it('ignores uncursored private side channels', () => {
    expect(
      parseGrokAcpSessionUpdate({
        jsonrpc: '2.0',
        method: '_x.ai/usage',
        params: { sessionId: 's1' },
      }),
    ).toBeNull()
  })

  it('accepts only provider stop reasons as turn fences', () => {
    for (const stopReason of [
      'end_turn',
      'max_tokens',
      'max_turn_requests',
      'refusal',
      'cancelled',
    ]) {
      expect(GrokAcpPromptResult.parse({ stopReason }).stopReason).toBe(stopReason)
    }
    expect(() => GrokAcpPromptResult.parse({ stopReason: 'done-ish' })).toThrow()
  })
})

describe('Grok permission authority', () => {
  const ask = grokPermissionAsk({
    requestId: 9,
    podiumSessionId: 'pod-1' as SessionId,
    at: '2026-08-16T00:00:00.000Z',
    request: {
      sessionId: 'grok-1',
      toolCall: { toolCallId: 'tool-1', kind: 'execute', rawInput: { command: 'pwd' } },
      options: [
        { optionId: 'yes-this-time', name: 'Allow', kind: 'allow_once' },
        { optionId: 'forever', name: 'Always', kind: 'allow-always' },
        { optionId: 'nope', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })

  it('projects the request_permission options into the structured ask', () => {
    expect(ask.interaction.kind).toBe('permission')
    expect(ask.interaction.payload).toMatchObject({
      toolName: 'execute',
      canAlwaysAllow: true,
      suggestions: [{ optionId: 'yes-this-time' }, { optionId: 'forever' }, { optionId: 'nope' }],
    })
  })

  it('consults this request options for every decision arm', () => {
    expect(grokPermissionAction(ask, { kind: 'permission', decision: 'allow-once' })).toMatchObject(
      { ok: true, option: { optionId: 'yes-this-time' } },
    )
    expect(
      grokPermissionAction(ask, { kind: 'permission', decision: 'allow-always' }),
    ).toMatchObject({ ok: true, option: { optionId: 'forever' } })
    expect(grokPermissionAction(ask, { kind: 'permission', decision: 'deny' })).toMatchObject({
      ok: true,
      option: { optionId: 'nope' },
    })
  })
})

describe('Grok ACP version floor', () => {
  it('admits the operator-set floor and later stable majors', () => {
    const floor = parseGrokVersion('grok 0.2.23')
    const stable = parseGrokVersion('grok 1.0.3')
    expect(floor).not.toBeNull()
    expect(stable).not.toBeNull()
    if (!floor || !stable) return
    expect(supportsGrokAcpDriver(floor)).toBe(true)
    expect(supportsGrokAcpDriver(stable)).toBe(true)
  })

  it('refuses older and unrecognizable builds with a diagnostic', () => {
    expect(gateGrokVersion('grok 0.2.22')).not.toBeNull()
    expect(gateGrokVersion('command not found')).not.toBeNull()
  })
})
