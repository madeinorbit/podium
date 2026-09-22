/**
 * READING A TURN'S OUTPUT (POD-4614). The live-progress cases moved from
 * apps/daemon/src/durable-headless.test.ts, where they read an abduco
 * journal: they read the host ring now, through the same line splitter a
 * hosted turn uses (so a split JSONL record still waits for its newline), and
 * the final fold is pinned below them.
 */
import type { HeadlessTurnEvent } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { HarnessHeadless } from '../../../manifest.js'
import { createHeadlessProgressReader, foldHeadlessOutcome } from './fold.js'
import { HeadlessTurnError } from './types.js'
import { createTurnLineSplitter, encodeTurnMarker, TURN_STDERR_PREFIX } from './wrapper.js'

/** The host ring as a turn sees it: marker first, then the child's bytes in
 *  arbitrary chunks. `push(chunk, flush)` mirrors the old journal parser. */
function ringReader(
  outputFormat: HarnessHeadless['outputFormat'],
  emit: (event: HeadlessTurnEvent) => void,
): { push(chunk: string, flush?: boolean): void } {
  const reader = createHeadlessProgressReader(outputFormat, emit)
  const splitter = createTurnLineSplitter((line) => {
    if (line.kind === 'stdout') reader.line(line.line)
  })
  let seq = 0n
  const feed = (text: string): void => {
    const bytes = Buffer.from(text, 'utf8')
    splitter.push(seq, bytes)
    seq += BigInt(bytes.length)
  }
  feed(`${encodeTurnMarker({ phase: 'turn', identityHash: 'h', createdAt: 1 })}\n`)
  return {
    push(chunk, flush = false) {
      feed(chunk)
      if (flush) splitter.flush()
    },
  }
}

describe('headless turn progress from the host ring', () => {
  it('publishes Codex session, tool, and assistant events as stdout lines arrive', () => {
    const events: HeadlessTurnEvent[] = []
    const parser = ringReader('codex-jsonl', (event) => events.push(event))

    parser.push('{"type":"thread.started","thread_id":"thread-live"}\n')
    expect(events).toEqual([{ kind: 'status', status: 'running', harnessSessionId: 'thread-live' }])

    // A partial line must stay buffered; the event appears only when the JSONL
    // record is complete, still well before any exit/result marker exists.
    parser.push(
      '{"type":"item.started","item":{"id":"tool-1","type":"mcp_tool_call","name":"sessions.status"}}',
    )
    expect(events).toHaveLength(1)
    parser.push('\n')
    expect(events.at(-1)).toEqual({
      kind: 'status',
      status: 'tool',
      label: 'sessions.status',
    })

    parser.push(
      '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"First live update"}}\n',
    )
    expect(events.at(-1)).toEqual({
      kind: 'partial-text',
      text: 'First live update',
      itemHint: 'msg-1',
    })
  })

  it('publishes pi session, tool, and cumulative partial text as its JSON stream lands', () => {
    const events: HeadlessTurnEvent[] = []
    const parser = ringReader('pi-jsonl', (event) => events.push(event))

    parser.push(
      '{"type":"session","version":3,"id":"9e804279-978a-4644-adc4-f815f25a5728","timestamp":"t","cwd":"/w"}\n',
    )
    expect(events).toEqual([
      {
        kind: 'status',
        status: 'running',
        harnessSessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      },
    ])
    parser.push(
      '{"type":"message_start","message":{"role":"assistant","content":[],"responseId":"r1"}}\n',
    )
    parser.push(
      '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}\n',
    )
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'tool', label: 'bash' })
    // A split line stays buffered until its newline arrives.
    parser.push('{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta",')
    expect(events).toHaveLength(2)
    parser.push('"contentIndex":0,"delta":"Reply "}}\n')
    parser.push(
      '{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"#2"}}\n',
    )
    expect(events.slice(-2)).toEqual([
      { kind: 'partial-text', text: 'Reply ', itemHint: 'r1' },
      { kind: 'partial-text', text: 'Reply #2', itemHint: 'r1' },
    ])
    parser.push(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reply #2 "}],"stopReason":"stop"}}',
      true,
    )
    // The authoritative final text is byte-identical to the streamed one: no duplicate frame.
    expect(events).toHaveLength(4)
  })

  it('publishes cumulative Claude partial text and tool activity from the host ring', () => {
    const events: HeadlessTurnEvent[] = []
    const parser = ringReader('claude-stream-json', (event) => events.push(event))

    parser.push(
      `${[
        '{"type":"system","subtype":"init","session_id":"claude-live"}',
        '{"type":"stream_event","uuid":"msg-1","event":{"type":"message_start"}}',
        '{"type":"stream_event","uuid":"msg-1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Working"}}}',
        '{"type":"stream_event","uuid":"msg-1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" live"}}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      ].join('\n')}\n`,
    )

    expect(events).toContainEqual({
      kind: 'status',
      status: 'running',
      harnessSessionId: 'claude-live',
    })
    expect(events).toContainEqual({
      kind: 'partial-text',
      text: 'Working live',
      itemHint: 'msg-1',
    })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'tool', label: 'Read' })
  })


  it('never reads a prefixed stderr line as output', () => {
    const events: HeadlessTurnEvent[] = []
    const parser = ringReader('codex-jsonl', (event) => events.push(event))
    parser.push(
      `${TURN_STDERR_PREFIX}{"type":"thread.started","thread_id":"from-stderr"}\n`,
    )
    expect(events).toEqual([])
  })
})

describe('foldHeadlessOutcome', () => {
  it('text output is the whole stdout, pinned to the known session', () => {
    expect(
      foldHeadlessOutcome({
        outputFormat: 'text',
        stdout: '  the answer\n',
        stderrTail: 'noise',
        exitCode: 0,
        pinnedSessionId: 's-1',
        agent: 'grok',
      }),
    ).toEqual({ harnessSessionId: 's-1', output: 'the answer' })
  })

  it('a nonzero exit fails with the stderr tail and still carries the session id', () => {
    let error: unknown
    try {
      foldHeadlessOutcome({
        outputFormat: 'codex-jsonl',
        stdout: '{"type":"thread.started","thread_id":"thr-9"}\n',
        stderrTail: 'boom\n',
        exitCode: 2,
        agent: 'codex',
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(HeadlessTurnError)
    expect((error as HeadlessTurnError).message).toBe('harness exited 2: boom')
    expect((error as HeadlessTurnError).harnessSessionId).toBe('thr-9')
  })

  it('a turn that never reports a session id fails rather than orphaning it', () => {
    expect(() =>
      foldHeadlessOutcome({
        outputFormat: 'codex-jsonl',
        stdout: '',
        stderrTail: '',
        exitCode: 0,
        agent: 'codex',
      }),
    ).toThrow('codex turn ended without reporting a session id')
  })
})
