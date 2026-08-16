import { readFileSync } from 'node:fs'
import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import recording from './__fixtures__/recording.json' with { type: 'json' }
import { createGrokAcpClient, type GrokAcpTransport } from './client.js'
import { grokPermissionAction, grokPermissionAsk } from './map.js'
import {
  GrokAcpFrame,
  GrokAcpInitializeResult,
  GrokAcpPermissionRequest,
  GrokAcpPromptResult,
  GrokAcpSessionResult,
  parseGrokAcpSessionUpdate,
} from './protocol.js'
import { gateGrokVersion, parseGrokVersion, supportsGrokAcpDriver } from './version.js'

const recordedFrames = readFileSync(
  new URL('./__fixtures__/live-frames.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => GrokAcpFrame.parse(JSON.parse(line)))

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

describe('Grok ACP recorded live fixtures (0.2.118)', () => {
  it('ties the captured build to a version this gate admits', () => {
    expect(recording.recordedFrom).toBe('grok 0.2.118 (1e1687c1cf) [stable]')
    expect(recording.transport).toBe('live `grok agent stdio` ACP JSON-RPC')
    expect(recording.redactions).toBe(
      'None. Frames with credentials and the user-specific available-command inventory were not selected.',
    )
    const version = parseGrokVersion(`grok ${recording.version}`)
    expect(version).not.toBeNull()
    if (!version) return
    expect(supportsGrokAcpDriver(version)).toBe(true)
  })

  it('parses the recorded handshake, new-session, and load-session frames', () => {
    const initializeRequest = recordedFrames.find((frame) => frame.method === 'initialize')
    expect(initializeRequest?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })

    const initializeResponse = recordedFrames.find((frame) => {
      if (frame.method || typeof frame.result !== 'object' || frame.result === null) return false
      return 'protocolVersion' in frame.result
    })
    const initialized = GrokAcpInitializeResult.parse(initializeResponse?.result)
    expect(initialized.agentCapabilities?.loadSession).toBe(true)

    const newSessionResponse = recordedFrames.find((frame) => {
      if (frame.method || typeof frame.result !== 'object' || frame.result === null) return false
      return 'sessionId' in frame.result
    })
    expect(GrokAcpSessionResult.parse(newSessionResponse?.result).sessionId).toMatch(/^[0-9a-f-]+$/)

    const loadRequest = recordedFrames.find((frame) => frame.method === 'session/load')
    expect(loadRequest?.params).toEqual({
      sessionId: '019ffd6d-f4c8-7c23-90bd-96cd86e783e9',
      cwd: '/tmp/grokprobe',
      mcpServers: [],
    })
    const loadResponse = recordedFrames.find((frame) => {
      if (frame.method || typeof frame.result !== 'object' || frame.result === null) return false
      if (!('_meta' in frame.result)) return false
      const meta = frame.result._meta
      return typeof meta === 'object' && meta !== null && 'sessionId' in meta
    })
    expect(loadResponse?.error).toBeUndefined()
  })

  it('parses the cursor-bearing live update the reducer consumes', () => {
    const updates = recordedFrames
      .map((frame) => parseGrokAcpSessionUpdate(frame))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.params).toMatchObject({
      update: { sessionUpdate: 'user_message_chunk' },
      _meta: { eventId: '019ffd6d-f4c8-7c23-90bd-96cd86e783e9-3' },
    })
  })

  it('parses the recorded server request with its zero id and typed options', () => {
    const frame = recordedFrames.find(
      (candidate) => candidate.method === 'session/request_permission',
    )
    expect(frame?.id).toBe(0)
    const request = GrokAcpPermissionRequest.parse(frame?.params)
    expect(request.toolCall.rawInput).toMatchObject({ command: 'echo ZEPHYR > probe.txt' })
    expect(request.options.map(({ optionId, kind }) => ({ optionId, kind }))).toEqual([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ])
    const answer = recordedFrames.find(
      (candidate) => candidate.id === 0 && candidate.method === undefined,
    )
    expect(answer?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('parses provider-fenced end_turn and cancelled prompt results', () => {
    const results = recordedFrames
      .filter((frame) => {
        if (frame.method || typeof frame.result !== 'object' || frame.result === null) return false
        return 'stopReason' in frame.result
      })
      .map((frame) => GrokAcpPromptResult.parse(frame.result).stopReason)
    expect(results).toContain('end_turn')
    expect(results).toContain('cancelled')
    expect(recordedFrames).toContainEqual(
      expect.objectContaining({
        method: 'session/cancel',
        params: { sessionId: '019ffd6f-014e-7e40-93be-0882a9f166b7' },
      }),
    )
  })
})

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
