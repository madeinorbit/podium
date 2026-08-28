// The durable tool record for a headless Claude turn (POD-3050).
//
// A turn that ran a tool used to reach the transcript as a prompt and an answer
// with a hole between them: the driver mapped `tool_use` to a status badge that
// nothing stores and ignored `tool_result` entirely, so the acceptance cell that
// asks for a paired, replayable tool record had nothing to read. These tests
// pin the pair, its order, its identity and its empty-output semantics.

import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkToolCall,
  type ClaudeSdkToolResult,
  type ClaudeSdkTurnHandle,
  createClaudeSdkRuntime,
} from './runtime.js'

const SESSION = 'claude-sdk-tools' as SessionId
const RESUME = '00000000-0000-4000-8000-0000000000aa'

function spec() {
  return {
    harness: 'claude-code' as const,
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['claude-sdk' as const],
      preference: 'claude-sdk' as const,
    },
    workdir: '/tmp/claude-sdk-tools',
    model: {},
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
}

interface Script {
  calls: readonly ClaudeSdkToolCall[]
  results: readonly ClaudeSdkToolResult[]
  /** Emitted in one interleaved sequence when set, so ordering is under test. */
  sequence?: readonly ({ call: ClaudeSdkToolCall } | { result: ClaudeSdkToolResult })[]
  output?: string
}

/** Run one turn whose provider reports `script`, and return the complete
 *  transcript items the runtime published for it. */
async function itemsForTurn(script: Script): Promise<TranscriptItem[]> {
  let settle: (() => void) | undefined
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => SESSION,
    mintResumeValue: () => RESUME,
    now: () => '2026-08-28T00:00:00.000Z',
    startTurn(input): ClaudeSdkTurnHandle {
      const done = new Promise<{ resumeValue: string; output: string }>((resolve) => {
        settle = () => resolve({ resumeValue: RESUME, output: script.output ?? 'answer' })
      })
      // Reported after the turn is open, exactly as a real child does.
      queueMicrotask(() => {
        const sequence = script.sequence ?? [
          ...script.calls.map((call) => ({ call })),
          ...script.results.map((result) => ({ result })),
        ]
        for (const step of sequence) {
          if ('call' in step) input.onToolCall(step.call)
          else input.onToolResult(step.result)
        }
        settle?.()
      })
      return { done, interrupt() {}, answerPermission() {}, dispose() {} }
    },
    async readTranscript() {
      return []
    },
    async readArchive() {
      return undefined
    },
  }

  const runtime = createClaudeSdkRuntime(host)
  const handle = await runtime.createWithId(SESSION, spec())
  const items: TranscriptItem[] = []
  const reading = (async () => {
    for await (const event of handle.events('bootstrap')) {
      if (event.t === 'item' && event.item.kind === 'complete') items.push(event.item.item)
      if (event.t === 'turn' && event.ev.ev === 'completed') break
    }
  })()
  await handle.send(
    { id: 't1', text: 'read the fixture' },
    { origin: 'human', delivery: 'when-ready' },
  )
  await reading
  await vi.waitFor(() => expect(items.some((i) => i.role === 'assistant')).toBe(true))
  return items
}

const call = (
  toolUseId: string,
  input: unknown = { command: 'cat marker.txt' },
): ClaudeSdkToolCall => ({
  toolUseId,
  toolName: 'Bash',
  input,
})

describe('the durable record of a headless Claude tool call', () => {
  it('publishes the call and its result as paired items, call before result', async () => {
    const items = await itemsForTurn({
      calls: [call('toolu_1')],
      results: [{ toolUseId: 'toolu_1', output: 'MARKER-OK' }],
    })
    const tools = items.filter((i) => i.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      id: 'toolu_1',
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolInput: 'cat marker.txt',
      toolUseId: 'toolu_1',
    })
    expect(tools[1]).toMatchObject({
      id: 'toolu_1-result',
      role: 'tool',
      text: '',
      toolResult: 'MARKER-OK',
      toolUseId: 'toolu_1',
    })
    // The join the renderer makes, and the whole point of the pair.
    expect(tools[0]?.toolUseId).toBe(tools[1]?.toolUseId)
    expect(tools[0]?.id).not.toBe(tools[1]?.id)
    // The user prompt and the assistant answer still bracket them, in order.
    expect(items.map((i) => i.role)).toEqual(['user', 'tool', 'tool', 'assistant'])
  })

  it('keeps a result behind its own call when two calls interleave', async () => {
    const items = await itemsForTurn({
      calls: [],
      results: [],
      sequence: [
        { call: call('toolu_a', { command: 'a' }) },
        { result: { toolUseId: 'toolu_a', output: 'A' } },
        { call: call('toolu_b', { command: 'b' }) },
        { result: { toolUseId: 'toolu_b', output: 'B' } },
      ],
    })
    expect(items.filter((i) => i.role === 'tool').map((i) => i.id)).toEqual([
      'toolu_a',
      'toolu_a-result',
      'toolu_b',
      'toolu_b-result',
    ])
  })

  it('publishes one item per call however many times the provider re-reports it', async () => {
    // A resumed conversation replays messages and a superseded assistant message
    // arrives again corrected; both carry the SAME tool_use id. Identity, not
    // arrival count, is what tells a repeat from a second call.
    const items = await itemsForTurn({
      calls: [call('toolu_dup'), call('toolu_dup'), call('toolu_dup')],
      results: [
        { toolUseId: 'toolu_dup', output: 'once' },
        { toolUseId: 'toolu_dup', output: 'once' },
      ],
    })
    expect(items.filter((i) => i.role === 'tool').map((i) => i.id)).toEqual([
      'toolu_dup',
      'toolu_dup-result',
    ])
  })

  it('records a tool that printed nothing as a finished call, not a missing one', async () => {
    const items = await itemsForTurn({
      calls: [call('toolu_quiet', { command: 'true' })],
      results: [{ toolUseId: 'toolu_quiet', output: '' }],
    })
    const result = items.find((i) => i.id === 'toolu_quiet-result')
    expect(result, 'an empty result is still a result').toBeDefined()
    // Present and empty — the renderer reads the item's existence, not its length.
    expect(result?.toolResult).toBe('')
    expect(result?.toolUseId).toBe('toolu_quiet')
  })

  it('carries the file a call touched so the chat can link it', async () => {
    const items = await itemsForTurn({
      calls: [
        { toolUseId: 'toolu_read', toolName: 'Read', input: { file_path: '/tmp/fixture.txt' } },
      ],
      results: [{ toolUseId: 'toolu_read', output: 'contents' }],
    })
    expect(items.find((i) => i.id === 'toolu_read')).toMatchObject({
      toolName: 'Read',
      toolInput: '/tmp/fixture.txt',
      toolPaths: ['/tmp/fixture.txt'],
    })
  })
})
