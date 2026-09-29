import { readFileSync } from 'node:fs'
import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import promptAck from './__fixtures__/prompt-ack.json' with { type: 'json' }
import recording from './__fixtures__/recording.json' with { type: 'json' }
import { createGrokAcpClient, type GrokAcpTransport } from './client.js'
import { grokPermissionAction, grokPermissionAsk } from './map.js'
import {
  GrokAcpFrame,
  GrokAcpInitializeResult,
  GrokAcpPermissionRequest,
  GrokAcpPromptResult,
  GrokAcpQueueChanged,
  GrokAcpSessionResult,
  grokAcpPromptId,
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

type Frame = (typeof recordedFrames)[number]
const loadAt = recordedFrames.findIndex((frame) => frame.method === 'session/load')
/** The recorded session's own process, before a second one loads it. */
const liveFrames = recordedFrames.slice(0, loadAt)
const replayFrames = recordedFrames.slice(loadAt)
const isResult = (frame: Frame): frame is Frame & { result: Record<string, unknown> } =>
  frame.method === undefined && typeof frame.result === 'object' && frame.result !== null
const promptRequests = liveFrames.filter((frame) => frame.method === 'session/prompt')
const promptIdOf = (frame: Frame): string | undefined =>
  (frame.params as { _meta?: { promptId?: string } } | undefined)?._meta?.promptId

describe('Grok ACP recorded live fixtures (1.0.44)', () => {
  it('ties the captured build to a version this gate admits', () => {
    expect(recording.recordedFrom).toBe('grok 1.0.44 (5b807183dd79) [stable]')
    expect(recording.transport).toBe('live `grok agent stdio` ACP JSON-RPC')
    expect(recording.redactions).toContain('/tmp/grokprobe')
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

    const initializeResponse = recordedFrames.find(
      (frame) => isResult(frame) && 'protocolVersion' in frame.result,
    )
    const initialized = GrokAcpInitializeResult.parse(initializeResponse?.result)
    expect(initialized.agentCapabilities?.loadSession).toBe(true)

    const newSessionResponse = liveFrames.find(
      (frame) => isResult(frame) && 'sessionId' in frame.result,
    )
    const sessionId = GrokAcpSessionResult.parse(newSessionResponse?.result).sessionId
    expect(sessionId).toMatch(/^[0-9a-f-]+$/)

    expect(replayFrames[0]?.params).toEqual({
      sessionId,
      cwd: '/tmp/grokprobe',
      mcpServers: [],
    })
    const loadResponse = replayFrames.find(
      (frame) => frame.method === undefined && frame.id === replayFrames[0]?.id,
    )
    expect(loadResponse).toBeDefined()
    expect(loadResponse?.error).toBeUndefined()
  })

  it('names every prompt by the promptId it was sent with, before any update of its turn', () => {
    expect(promptRequests.map(promptIdOf)).toEqual([
      'msg_01fixture-hello',
      'msg_02fixture-tool',
      'msg_03fixture-cancel',
      'msg_01fixture-hello',
    ])
    for (const request of promptRequests) {
      const promptId = promptIdOf(request)
      const after = liveFrames.slice(liveFrames.indexOf(request) + 1)
      const ack = after.findIndex(
        (frame) =>
          frame.method === '_x.ai/queue/changed' &&
          GrokAcpQueueChanged.parse(frame.params).runningPromptId === promptId,
      )
      const firstUpdate = after.findIndex((frame) => parseGrokAcpSessionUpdate(frame) !== null)
      expect(ack).toBeGreaterThanOrEqual(0)
      expect(ack).toBeLessThan(firstUpdate)
      // The reply to the request carries the same id.
      const reply = after.find((frame) => frame.id === request.id && frame.method === undefined)
      expect(GrokAcpPromptResult.parse(reply?.result)._meta).toMatchObject({ promptId })
    }
  })

  it('sends no user_message_chunk live, and stamps the turn with its promptId', () => {
    const live = liveFrames
      .map((frame) => parseGrokAcpSessionUpdate(frame))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
    expect(
      live.filter((frame) => frame.params.update.sessionUpdate === 'user_message_chunk'),
    ).toEqual([])
    const turnUpdates = live.filter((frame) =>
      ['agent_message_chunk', 'tool_call', 'turn_completed'].includes(
        String(frame.params.update.sessionUpdate),
      ),
    )
    expect(turnUpdates.length).toBeGreaterThan(0)
    for (const update of turnUpdates) {
      expect(grokAcpPromptId(update)).toMatch(/^msg_0[123]fixture-/)
    }
  })

  it("replays each user record ahead of an update stamped with its turn's promptId", () => {
    const replay = replayFrames
      .map((frame) => parseGrokAcpSessionUpdate(frame))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
    const keyed: [string, string | undefined][] = []
    replay.forEach((frame, index) => {
      if (frame.params.update.sessionUpdate !== 'user_message_chunk') return
      expect(grokAcpPromptId(frame)).toBeUndefined()
      const next = replay.slice(index + 1).find((later) => grokAcpPromptId(later) !== undefined)
      const content = frame.params.update.content as { text?: string }
      keyed.push([String(content.text), next && grokAcpPromptId(next)])
    })
    // The repeated promptId is a second turn and a second record.
    expect(keyed).toEqual([
      ['say hello', 'msg_01fixture-hello'],
      ['toolme please', 'msg_02fixture-tool'],
      ['slowme please', 'msg_03fixture-cancel'],
      ['say hello', 'msg_01fixture-hello'],
    ])
  })

  it('parses the recorded server request with its zero id and typed options', () => {
    const frame = recordedFrames.find(
      (candidate) => candidate.method === 'session/request_permission',
    )
    expect(frame?.id).toBe(0)
    const request = GrokAcpPermissionRequest.parse(frame?.params)
    expect(request.toolCall.rawInput).toMatchObject({ command: 'echo ZEPHYR > probe.txt' })
    expect(request.options.map(({ optionId, kind }) => ({ optionId, kind }))).toEqual(
      expect.arrayContaining([
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ]),
    )
    const answer = recordedFrames.find(
      (candidate) => candidate.id === 0 && candidate.method === undefined,
    )
    expect(answer?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('parses provider-fenced end_turn and cancelled prompt results', () => {
    const results = liveFrames
      .filter((frame) => isResult(frame) && 'stopReason' in frame.result)
      .map((frame) => GrokAcpPromptResult.parse(frame.result).stopReason)
    expect(results).toEqual(['end_turn', 'end_turn', 'cancelled', 'end_turn'])
    const cancel = recordedFrames.find((frame) => frame.method === 'session/cancel')
    const loaded = replayFrames[0]?.params as { sessionId?: string } | undefined
    expect(cancel?.params).toEqual({ sessionId: loaded?.sessionId })
  })
})

describe('Grok ACP prompt acknowledgement, measured (1.0.44)', () => {
  type Entry = { t: number; dir: string; mark?: string; frame?: Frame }
  const scenario = (name: keyof typeof promptAck.scenarios) =>
    promptAck.scenarios[name] as unknown as { frames: Entry[]; recordedUpdates: Frame[] }
  const frames = (name: keyof typeof promptAck.scenarios): Frame[] =>
    scenario(name)
      .frames.filter((entry) => entry.frame !== undefined)
      .map((entry) => GrokAcpFrame.parse(entry.frame))
  const turnCompleted = (all: Frame[], promptId: string) =>
    all
      .map((frame) => parseGrokAcpSessionUpdate(frame))
      .find(
        (frame) =>
          frame?.params.update.sessionUpdate === 'turn_completed' &&
          grokAcpPromptId(frame) === promptId,
      )

  it('ignores a top-level messageId and runs a repeated promptId as a second turn', () => {
    const all = frames('promptIdAndMessageId')
    const replies = all.filter((frame) => isResult(frame) && 'stopReason' in frame.result)
    const ids = replies.map((frame) => GrokAcpPromptResult.parse(frame.result)._meta?.promptId)
    expect(ids[0]).toBe('podmsg-A')
    // The messageId request got an id Grok minted.
    expect(ids[1]).not.toBe('0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')
    expect(ids[2]).toBe('podmsg-A')
    const records = scenario('promptIdAndMessageId').recordedUpdates.filter(
      (frame) =>
        (frame.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
        'user_message_chunk',
    )
    expect(records).toHaveLength(4)
  })

  it('acks before the UserPromptSubmit hook, and never records a prompt it blocks', () => {
    const all = frames('userPromptSubmitHook')
    const blocked = turnCompleted(all, 'podmsg-I')
    expect(blocked?.params._meta).toMatchObject({ cancellationCategory: 'HookDenied' })
    const recordedTexts = scenario('userPromptSubmitHook')
      .recordedUpdates.map(
        (frame) =>
          (frame.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })
            .update,
      )
      .filter((update) => update?.sessionUpdate === 'user_message_chunk')
      .map((update) => update?.content?.text)
    expect(recordedTexts).toEqual(['hotel eight', 'juliet ten'])
  })

  it('names and records a prompt whose provider call fails, then answers with an error', () => {
    const all = frames('providerFailure')
    const ack = all.findIndex(
      (frame) =>
        frame.method === '_x.ai/queue/changed' &&
        GrokAcpQueueChanged.parse(frame.params).runningPromptId === 'podmsg-K',
    )
    const error = all.findIndex((frame) => frame.error !== undefined)
    expect(ack).toBeGreaterThanOrEqual(0)
    expect(ack).toBeLessThan(error)
    expect(turnCompleted(all, 'podmsg-K')?.params.update).toMatchObject({ stop_reason: 'error' })
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

  it('never times out session/prompt, whose reply comes only at the end of the turn', async () => {
    const transport = new TestTransport()
    const timed: number[] = []
    const client = createGrokAcpClient({
      transport,
      onNotification() {},
      onServerRequest() {},
      setTimer: (_fn, ms) => {
        timed.push(ms)
        return timed.length
      },
      clearTimer: () => {},
    })
    const initializing = client.initialize()
    const initialize = JSON.parse(transport.writes[0] ?? '{}')
    transport.receive({ jsonrpc: '2.0', id: initialize.id, result: { protocolVersion: 1 } })
    await initializing
    expect(timed).toHaveLength(1)
    void client.call('session/prompt', { sessionId: 's1', prompt: [] })
    expect(timed).toHaveLength(1)
    void client.call('session/set_mode', { sessionId: 's1', modeId: 'default' })
    expect(timed).toHaveLength(2)
  })

  it('takes the durable cursor from _meta.eventId on every cursor-bearing method', () => {
    for (const method of [
      'session/update',
      '_x.ai/session/update',
      '_x.ai/session_notification',
    ] as const) {
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

  it('refuses older builds but admits an unrecognizable version', () => {
    expect(gateGrokVersion('grok 0.2.22')).not.toBeNull()
    expect(gateGrokVersion('command not found')).toBeNull()
  })
})
