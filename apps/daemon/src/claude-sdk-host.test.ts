// apps/daemon/src/claude-sdk-host.test.ts
//
// The host's own lifecycle, with the SDK stubbed so the turn is controllable.
// The daemon side is covered by claude-sdk-client.test.ts against real child
// processes; what can only be tested here is what the host does when the thing
// on the other end of its stdin goes away.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSdkHostFrame } from './claude-sdk-protocol.js'

const sdk = vi.hoisted(() => ({
  interruptCalled: false,
  /** Set to make `query.interrupt()` reject — the case whose answer used to be
   *  discarded, and which is therefore the case worth being able to stage. */
  interruptError: null as string | null,
  endStream: undefined as (() => void) | undefined,
  scripted: null as unknown[] | null,
  queryInput: null as { options?: Record<string, unknown> } | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (input: { options?: Record<string, unknown> }) => {
    sdk.queryInput = input
    const scripted = sdk.scripted
    if (scripted) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of scripted) yield message
        },
        interrupt: async () => {
          sdk.interruptCalled = true
          if (sdk.interruptError) throw new Error(sdk.interruptError)
        },
      }
    }
    let done = false
    const waiters: (() => void)[] = []
    // Closes THIS query's stream, not whichever query happened to be created
    // last. It used to be read back off the shared `sdk.endStream` slot, so a
    // late interrupt from a finished test ended the NEXT test's turn instead —
    // a turn that stopped before its own interrupt command ever arrived.
    const endStream = () => {
      done = true
      for (const w of waiters.splice(0)) w()
    }
    sdk.endStream = endStream
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-stub' }
        while (!done) await new Promise<void>((r) => waiters.push(r))
      },
      interrupt: async () => {
        sdk.interruptCalled = true
        if (sdk.interruptError) throw new Error(sdk.interruptError)
        endStream()
      },
    }
  },
}))

const { runClaudeSdkHost } = await import('./claude-sdk-host.js')

afterEach(() => {
  sdk.interruptCalled = false
  sdk.interruptError = null
  sdk.endStream = undefined
  sdk.scripted = null
  sdk.queryInput = null
})

const TURN = JSON.stringify({
  t: 'turn',
  spec: {
    agent: 'claude-code',
    accountId: 'native:claude-code:test',
    requestDigest: 'a'.repeat(64),
    cwd: process.cwd(),
    prompt: 'hello',
  },
})

/** Commands that arrive, then stop — stdin EOF, i.e. the daemon is gone. */
async function* commandsThenEof(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) {
    yield line
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('the SDK host when its daemon disappears', () => {
  it('winds the turn down instead of outliving the daemon that started it', async () => {
    // THE BUG AN ADVERSARIAL REVIEW FOUND. The stdin-EOF branch used to be
    // `if (!spec) finish()`, so once a turn had started EOF did nothing at all:
    // the daemon died, and this process kept a model session, a working directory
    // and whatever the CLI spawned running with nobody left to stop it. The
    // comment above main() claimed the opposite, which is the worst combination —
    // a promise in prose that the code does not keep.
    //
    // If this regresses, the stream below never ends and this test times out,
    // which is exactly what an orphan is.
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN]),
      send: (f) => frames.push(f),
    })
    expect(sdk.interruptCalled, 'the host must interrupt its turn when stdin closes').toBe(true)
    expect(frames.some((f) => f.t === 'session')).toBe(true)
  }, 20_000)

  it('exits immediately when stdin closes before any turn arrives', async () => {
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({ commands: commandsThenEof([]), send: (f) => frames.push(f) })
    expect(frames).toEqual([])
    expect(sdk.interruptCalled).toBe(false)
  }, 10_000)

  it('honours an interrupt command that arrives while the turn is running', async () => {
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN, JSON.stringify({ t: 'interrupt' })]),
      send: (f) => frames.push(f),
    })
    expect(sdk.interruptCalled).toBe(true)
  }, 10_000)
})

// THE SILENCE THIS ISSUE WAS FILED ABOUT. `q.interrupt()` was called as
// `void q.interrupt().catch(() => {})` — the SDK's answer, including its
// refusals, went into a swallow. Nothing downstream could tell a turn that had
// been stopped from one that had declined to stop, so the daemon reported both
// as success and the operator was shown a stop that had not happened.
describe('the SDK host answers the interrupt it was asked for', () => {
  const ackOf = (frames: ClaudeSdkHostFrame[]) =>
    frames.filter(
      (f): f is Extract<ClaudeSdkHostFrame, { t: 'interrupt-ack' }> => f.t === 'interrupt-ack',
    )

  it('acknowledges acceptance only once the provider has actually answered', async () => {
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN, JSON.stringify({ t: 'interrupt', requestId: 'req-1' })]),
      send: (f) => frames.push(f),
    })
    expect(ackOf(frames)).toEqual([{ t: 'interrupt-ack', requestId: 'req-1', accepted: true }])
  }, 10_000)

  it("reports a refused interrupt as refused, with the provider's reason", async () => {
    sdk.interruptError = 'stream is already closed'
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN, JSON.stringify({ t: 'interrupt', requestId: 'req-2' })]),
      send: (f) => frames.push(f),
    })
    expect(ackOf(frames)).toEqual([
      {
        t: 'interrupt-ack',
        requestId: 'req-2',
        accepted: false,
        detail: 'stream is already closed',
      },
    ])
  }, 10_000)

  it('refuses an interrupt with nothing to interrupt instead of staying silent', async () => {
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([JSON.stringify({ t: 'interrupt', requestId: 'req-3' })]),
      send: (f) => frames.push(f),
    })
    expect(ackOf(frames)).toEqual([
      {
        t: 'interrupt-ack',
        requestId: 'req-3',
        accepted: false,
        detail: 'no turn was in flight to interrupt',
      },
    ])
    expect(sdk.interruptCalled).toBe(false)
  }, 10_000)

  it('answers an interrupt that raced the turn it was meant to stop', async () => {
    // The request arrives in the gap between `turn` and the SDK query existing.
    // It used to become a bare boolean that was replayed at nobody.
    const frames: ClaudeSdkHostFrame[] = []
    async function* raced(): AsyncGenerator<string> {
      yield TURN
      yield JSON.stringify({ t: 'interrupt', requestId: 'req-4' })
      await new Promise((r) => setTimeout(r, 50))
    }
    await runClaudeSdkHost({ commands: raced(), send: (f) => frames.push(f) })
    expect(ackOf(frames)).toEqual([{ t: 'interrupt-ack', requestId: 'req-4', accepted: true }])
  }, 10_000)
})

describe('SDK result error frames', () => {
  it('puts a bounded redacted diagnostic on the error frame, not only the subtype', async () => {
    sdk.scripted = [
      { type: 'system', subtype: 'init', session_id: 'sess-limit' },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ["You've hit your monthly spend limit CLAUDE_CODE_OAUTH_TOKEN=oat_secret"],
      },
    ]
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN]),
      send: (f) => frames.push(f),
    })
    const error = frames.find((f) => f.t === 'error')
    expect(error).toMatchObject({ t: 'error', harnessSessionId: 'sess-limit' })
    expect(error && 'message' in error ? error.message : '').toMatch(/monthly spend limit/i)
    expect(error && 'message' in error ? error.message : '').toMatch(/error_during_execution/)
    expect(error && 'message' in error ? error.message : '').not.toMatch(/oat_secret/)
  }, 10_000)
})

describe('the SDK host reports completed-turn configuration', () => {
  it('keeps requested SDK options separate from provider-observed fields', async () => {
    sdk.scripted = [
      { type: 'system', subtype: 'init', session_id: 'sess-configured' },
      {
        type: 'assistant',
        uuid: 'configured-answer',
        message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    ]
    const configuredTurn = JSON.stringify({
      t: 'turn',
      spec: {
        agent: 'claude-code',
        accountId: 'native:claude-code:test',
        requestDigest: 'a'.repeat(64),
        cwd: process.cwd(),
        prompt: 'hello',
        model: 'claude-opus-5',
        effort: 'max',
      },
    })
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([configuredTurn]),
      send: (frame) => frames.push(frame),
    })
    expect(sdk.queryInput?.options).toMatchObject({ model: 'claude-opus-5', effort: 'max' })
    expect(frames.find((frame) => frame.t === 'done')).toEqual(
      expect.objectContaining({
        observedModel: 'claude-opus-5',
      }),
    )
    expect(frames.find((frame) => frame.t === 'done')).not.toHaveProperty('observedEffort')
  }, 10_000)

  it('carries effort only when the assistant event reports it', async () => {
    sdk.scripted = [
      { type: 'system', subtype: 'init', session_id: 'sess-observed-effort' },
      {
        type: 'assistant',
        uuid: 'observed-effort-answer',
        message: {
          model: 'claude-opus-5',
          effort: 'max',
          content: [{ type: 'text', text: 'done' }],
        },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    ]
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN]),
      send: (frame) => frames.push(frame),
    })
    expect(frames.find((frame) => frame.t === 'done')).toMatchObject({
      observedModel: 'claude-opus-5',
      observedEffort: 'max',
    })
  }, 10_000)
})

describe('the SDK host records the tools a turn ran (POD-3050)', () => {
  /** One scripted turn: an assistant message with `blocks`, then the tool
   *  results in `results`, then a successful result. */
  async function runTurn(blocks: unknown[], results: unknown[]): Promise<ClaudeSdkHostFrame[]> {
    sdk.scripted = [
      { type: 'system', subtype: 'init', session_id: 'sess-tools' },
      { type: 'assistant', uuid: 'u1', message: { content: blocks } },
      ...results.map((content) => ({ type: 'user', message: { content } })),
      { type: 'result', subtype: 'success', result: 'done' },
    ]
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({ commands: commandsThenEof([TURN]), send: (f) => frames.push(f) })
    return frames
  }

  it('emits the call and its result as a pair, call first', async () => {
    // THE DEFECT: `tool_use` mapped only to a status badge and `tool_result`
    // was not read at all, so a turn that read a file reached the transcript as
    // a prompt and an answer with nothing in between.
    const frames = await runTurn(
      [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat marker.txt' } }],
      [[{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'MARKER-OK' }]],
    )
    const tools = frames.filter((f) => f.t === 'tool-call' || f.t === 'tool-result')
    expect(tools).toEqual([
      {
        t: 'tool-call',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'cat marker.txt' },
      },
      { t: 'tool-result', toolUseId: 'toolu_1', output: 'MARKER-OK' },
    ])
    // The badge is not the record, but it must not have been dropped either.
    expect(
      frames.some((f) => f.t === 'event' && f.event.kind === 'status' && f.event.status === 'tool'),
    ).toBe(true)
  }, 10_000)

  it('keeps parallel calls in the order the model issued them', async () => {
    const frames = await runTurn(
      [
        { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/b' } },
      ],
      [
        [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: 'B' },
        ],
      ],
    )
    expect(
      frames
        .filter((f) => f.t === 'tool-call' || f.t === 'tool-result')
        .map((f) => `${f.t}:${'toolUseId' in f ? f.toolUseId : ''}`),
    ).toEqual([
      'tool-call:toolu_a',
      'tool-call:toolu_b',
      'tool-result:toolu_a',
      'tool-result:toolu_b',
    ])
  }, 10_000)

  it('reports a tool that printed nothing as a result with empty output, not as no result', async () => {
    // Absent content and empty content are the same fact — the call returned.
    // Dropping the frame would leave the call looking like it never came back.
    const frames = await runTurn(
      [{ type: 'tool_use', id: 'toolu_q', name: 'Bash', input: { command: 'true' } }],
      [
        [
          { type: 'tool_result', tool_use_id: 'toolu_q' },
          { type: 'tool_result', tool_use_id: 'toolu_e', content: [] },
        ],
      ],
    )
    expect(frames.filter((f) => f.t === 'tool-result')).toEqual([
      { t: 'tool-result', toolUseId: 'toolu_q', output: '' },
      { t: 'tool-result', toolUseId: 'toolu_e', output: '' },
    ])
  }, 10_000)

  it('flattens block-shaped result content and carries the error flag', async () => {
    const frames = await runTurn(
      [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'false' } }],
      [
        [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            is_error: true,
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      ],
    )
    expect(frames.filter((f) => f.t === 'tool-result')).toEqual([
      { t: 'tool-result', toolUseId: 'toolu_x', output: 'line one\nline two', isError: true },
    ])
  }, 10_000)

  it('ignores a typed user prompt and a nameless call rather than inventing a record', async () => {
    const frames = await runTurn(
      [{ type: 'tool_use', name: 'Bash', input: {} }],
      ['just text', [{ type: 'text', text: 'hello' }]],
    )
    expect(frames.filter((f) => f.t === 'tool-call' || f.t === 'tool-result')).toEqual([])
  }, 10_000)
})
