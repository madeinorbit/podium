// The stream-json wire, hermetically: argv, handshake, turns, permissions,
// interrupts and death — over a fake line transport, no CLI, no SDK.

import { describe, expect, it, vi } from 'vitest'
import {
  buildClaudeStreamInvocation,
  claudeStreamEnvOverlay,
  createClaudeStreamClient,
  initializePayload,
  mcpConfigInline,
  userMessageLine,
  type ClaudeStreamTransport,
} from './protocol.js'

function fakeTransport(): {
  transport: ClaudeStreamTransport
  writes: string[]
  emitLine(line: string): void
  exit(code: number | null, signal: string | null): void
  closed: boolean
} {
  const writes: string[] = []
  const lineCbs = new Set<(line: string) => void>()
  const exitCbs = new Set<(code: number | null, signal: string | null) => void>()
  let closed = false
  return {
    writes,
    get closed() {
      return closed
    },
    transport: {
      writeLine: (line) => {
        writes.push(line)
      },
      onLine: (cb) => {
        lineCbs.add(cb)
        return () => lineCbs.delete(cb)
      },
      onExit: (cb) => {
        exitCbs.add(cb)
        return () => exitCbs.delete(cb)
      },
      close: () => {
        closed = true
      },
    },
    emitLine: (line) => {
      for (const cb of [...lineCbs]) cb(line)
    },
    exit: (code, signal) => {
      for (const cb of [...exitCbs]) cb(code, signal)
    },
  }
}

const frame = (value: unknown): string => JSON.stringify(value)

function answerInitialize(fake: ReturnType<typeof fakeTransport>, response: unknown = {}): void {
  const init = fake.writes.map((line) => JSON.parse(line)).find(
    (msg) => msg.type === 'control_request' && msg.request?.subtype === 'initialize',
  )
  expect(init).toBeDefined()
  fake.emitLine(
    frame({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response } }),
  )
}

function answerInitSystem(fake: ReturnType<typeof fakeTransport>, sessionId: string): void {
  fake.emitLine(frame({ type: 'system', subtype: 'init', session_id: sessionId }))
}

function completeTurn(
  fake: ReturnType<typeof fakeTransport>,
  sessionId: string,
  output = 'the answer',
): void {
  answerInitialize(fake)
  answerInitSystem(fake, sessionId)
}

describe('the stream-json invocation', () => {
  const base = { prompt: 'hello', cwd: '/work' }

  it('speaks streaming stdio with partial messages', () => {
    const { cmd, args } = buildClaudeStreamInvocation(base, 'claude')
    expect(cmd).toBe('claude')
    expect(args.slice(0, 6)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
    ])
  })

  it('defaults the permission mode to auto, default under structured permissions', () => {
    const auto = buildClaudeStreamInvocation(base, 'claude')
    expect(auto.args).toContain('--permission-mode')
    expect(auto.args[auto.args.indexOf('--permission-mode') + 1]).toBe('auto')
    const structured = buildClaudeStreamInvocation({ ...base, structuredPermissions: true }, 'claude')
    expect(structured.args[structured.args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(structured.args).toContain('--permission-prompt-tool')
  })

  it('honours an explicit permission mode and the root bypass flag', () => {
    const bypass = buildClaudeStreamInvocation({ ...base, permissionMode: 'bypassPermissions' }, 'claude')
    expect(bypass.args).toContain('--allow-dangerously-skip-permissions')
    const plan = buildClaudeStreamInvocation({ ...base, permissionMode: 'plan' }, 'claude')
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('passes model, effort, resume and session minting through', () => {
    const { args } = buildClaudeStreamInvocation(
      { ...base, model: 'claude-opus-5', effort: 'max', resumeValue: 'abc', allowedTools: ['Read', 'Bash'] },
      'claude',
    )
    expect(args).toContain('--model')
    expect(args).toContain('claude-opus-5')
    expect(args).toContain('--effort')
    expect(args).toContain('--resume')
    expect(args).toContain('--allowedTools')
    const mint = buildClaudeStreamInvocation({ ...base, sessionUuid: 'uuid-1' }, 'claude')
    expect(mint.args).toContain('--session-id')
    expect(mint.args).not.toContain('--resume')
  })

  it('removes tools and setting sources fail-closed, and refuses malformed MCP', () => {
    const { args } = buildClaudeStreamInvocation({ ...base, toolPolicy: 'none' }, 'claude')
    expect(args).toContain('--tools')
    expect(args).toContain('--setting-sources')
    expect(() => mcpConfigInline('not json')).toThrow(/malformed MCP config/)
  })

  it('mounts MCP as inline JSON, dropping url-less servers', () => {
    const inline = mcpConfigInline(
      JSON.stringify({ mcpServers: { docs: { url: 'https://mcp/x' }, empty: {} } }),
    )
    expect(JSON.parse(inline)).toEqual({ mcpServers: { docs: { type: 'http', url: 'https://mcp/x' } } })
    const { args } = buildClaudeStreamInvocation(
      { ...base, mcpConfig: JSON.stringify({ mcpServers: { docs: { url: 'https://mcp/x' } } }) },
      'claude',
    )
    expect(args).toContain('--mcp-config')
  })

  it('pins IS_SANDBOX for root bypass turns only', () => {
    expect(claudeStreamEnvOverlay({ permissionMode: 'bypassPermissions', isRoot: true })).toEqual({
      IS_SANDBOX: '1',
    })
    expect(claudeStreamEnvOverlay({ permissionMode: 'bypassPermissions', isRoot: false })).toEqual({})
    expect(claudeStreamEnvOverlay({ permissionMode: 'auto', isRoot: true })).toEqual({})
  })

  it('carries the orchestrator prompt on initialize, never argv', () => {
    expect(initializePayload({ systemPrompt: 'sys', contextPrompt: 'ctx' })).toEqual({
      subtype: 'initialize',
      appendSystemPrompt: 'sys\n\nctx',
    })
    expect(initializePayload({})).toEqual({ subtype: 'initialize' })
    const { args } = buildClaudeStreamInvocation({ ...base, systemPrompt: 'sys' }, 'claude')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--system-prompt')
  })

  it('writes the user line in the SDK string-prompt shape', () => {
    expect(JSON.parse(userMessageLine('hi'))).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    })
  })
})

describe('the stream client', () => {
  it('runs one turn: initialize, user line, partials, tools, result', async () => {
    const fake = fakeTransport()
    const partials: Array<{ text: string; itemHint?: string }> = []
    const calls: Array<{ toolUseId: string; toolName: string }> = []
    const results: Array<{ toolUseId: string; output: string }> = []
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('hello', {
      onPartialText: (text, itemHint) => partials.push({ text, ...(itemHint ? { itemHint } : {}) }),
      onPermission: () => {},
      onToolCall: (call) => calls.push(call),
      onToolResult: (result) => results.push(result),
      emit: () => {},
    })
    completeTurn(fake, 'sess-1')
    // The user line goes out once the handshake is answered — a microtask
    // after the answer lands, so the handshake settles first.
    await client.ready
    await vi.waitFor(() => {
      const user = fake.writes.map((line) => JSON.parse(line)).find((msg) => msg.type === 'user')
      expect(user?.message.content).toEqual([{ type: 'text', text: 'hello' }])
    })
    fake.emitLine(
      frame({
        type: 'stream_event',
        uuid: 'msg-1',
        event: { type: 'message_start' },
      }),
    )
    fake.emitLine(
      frame({
        type: 'stream_event',
        uuid: 'msg-1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
      }),
    )
    fake.emitLine(
      frame({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { p: 1 } }],
        },
      }),
    )
    fake.emitLine(
      frame({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file!' }] },
      }),
    )
    fake.emitLine(frame({ type: 'result', subtype: 'success', result: 'the answer' }))
    await expect(turn.done).resolves.toEqual({
      harnessSessionId: 'sess-1',
      output: 'the answer',
      observedModel: 'claude-opus-5',
    })
    expect(partials).toEqual([{ text: 'hel', itemHint: 'msg-1' }])
    expect(calls).toEqual([{ toolUseId: 'tu-1', toolName: 'Read', input: { p: 1 } }])
    expect(results).toEqual([{ toolUseId: 'tu-1', output: 'file!' }])
    await expect(client.ready).resolves.toBe('sess-1')
  })

  it('writes the first user line on the initialize answer alone, before any system/init', async () => {
    // claude-code 2.1.280 in streaming-input mode answers `initialize` and
    // then waits: `system/init` is its reply to the first user line. The
    // client learns the id from the invocation that named it.
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, { sessionId: 'minted-1' })
    const turn = client.turn('hello', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    answerInitialize(fake)
    await expect(client.ready).resolves.toBe('minted-1')
    await vi.waitFor(() =>
      expect(fake.writes.map((line) => JSON.parse(line)).some((msg) => msg.type === 'user')).toBe(true),
    )
    answerInitSystem(fake, 'minted-1')
    fake.emitLine(frame({ type: 'result', subtype: 'success', result: 'hi' }))
    await expect(turn.done).resolves.toMatchObject({ harnessSessionId: 'minted-1', output: 'hi' })
  })

  it('writes the first user line on the initialize answer even when no id was named', async () => {
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('hello', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    answerInitialize(fake)
    await vi.waitFor(() =>
      expect(fake.writes.map((line) => JSON.parse(line)).some((msg) => msg.type === 'user')).toBe(true),
    )
    // The id is the CLI's to report, and it reports it in reply to the line.
    answerInitSystem(fake, 'reported-1')
    await expect(client.ready).resolves.toBe('reported-1')
    fake.emitLine(frame({ type: 'result', subtype: 'success', result: 'hi' }))
    await expect(turn.done).resolves.toMatchObject({ harnessSessionId: 'reported-1' })
  })

  it('routes a permission ask and answers it on the wire', async () => {
    const fake = fakeTransport()
    const asked: Array<{ id: string; toolName: string }> = []
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('run it', {
      onPartialText: () => {},
      onPermission: (request) => asked.push({ id: request.id, toolName: request.toolName }),
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    completeTurn(fake, 'sess-2')
    await client.ready
    fake.emitLine(
      frame({
        type: 'control_request',
        request_id: 'req-9',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { c: 'ls' }, tool_use_id: 'tu-9' },
      }),
    )
    expect(asked).toHaveLength(1)
    turn.answerPermission(asked[0]!.id, { decision: 'allow-once' })
    const answer = fake.writes.map((line) => JSON.parse(line)).find((msg) => msg.type === 'control_response')
    expect(answer.response).toMatchObject({
      subtype: 'success',
      request_id: 'req-9',
      response: { behavior: 'allow', toolUseID: 'tu-9' },
    })
    fake.emitLine(frame({ type: 'result', subtype: 'success', result: 'done' }))
    await expect(turn.done).resolves.toMatchObject({ harnessSessionId: 'sess-2', output: 'done' })
  })

  it('acknowledges an interrupt with the CLI verdict', async () => {
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('long', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    completeTurn(fake, 'sess-3')
    const ack = turn.requestInterrupt()
    const interrupt = fake.writes.map((line) => JSON.parse(line)).find(
      (msg) => msg.type === 'control_request' && msg.request?.subtype === 'interrupt',
    )
    expect(interrupt.request_id).toBeTruthy()
    fake.emitLine(
      frame({
        type: 'control_response',
        response: { subtype: 'success', request_id: interrupt.request_id, response: {} },
      }),
    )
    await expect(ack).resolves.toEqual({ outcome: 'accepted' })
    client.close()
  })

  it('answers unconfirmed when the CLI stays silent past the deadline', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeTransport()
      const client = createClaudeStreamClient(fake.transport, {})
      const turn = client.turn('long', {
        onPartialText: () => {},
        onPermission: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        emit: () => {},
      })
      completeTurn(fake, 'sess-3b')
      const pending = turn.requestInterrupt()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(pending).resolves.toEqual({
        outcome: 'unconfirmed',
        detail: expect.stringContaining('did not confirm'),
      })
      client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the turn when the transport dies mid-turn', async () => {
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('hello', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    completeTurn(fake, 'sess-4')
    fake.exit(1, null)
    await expect(turn.done).rejects.toThrow(
      'the Claude model host process exited with code 1 before the turn finished',
    )
  })

  it('fails a timed-out turn even when the CLI reports done', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeTransport()
      const client = createClaudeStreamClient(fake.transport, { timeoutMs: 1_000 })
      const turn = client.turn('hello', {
        onPartialText: () => {},
        onPermission: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        emit: () => {},
      })
      const settled = turn.done
      completeTurn(fake, 'sess-5')
      await vi.advanceTimersByTimeAsync(1_000)
      fake.emitLine(frame({ type: 'result', subtype: 'success', result: 'half a sentence' }))
      await expect(settled).rejects.toThrow('turn timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a result error with the harness session id attached', async () => {
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('hello', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    completeTurn(fake, 'sess-6')
    fake.emitLine(frame({ type: 'result', subtype: 'error', errors: ['boom'] }))
    const failure = (await turn.done.catch((error: unknown) => error)) as Error
    expect(failure.message).toContain('boom')
    expect(failure).toMatchObject({ harnessSessionId: 'sess-6' })
  })

  it('declines elicitations, errors hooks, and stays silent on dialogs', async () => {
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, {})
    client.turn('hi', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    completeTurn(fake, 'sess-7')
    fake.writes.length = 0
    fake.emitLine(
      frame({ type: 'control_request', request_id: 'e1', request: { subtype: 'elicitation' } }),
    )
    fake.emitLine(
      frame({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } }),
    )
    fake.emitLine(
      frame({ type: 'control_request', request_id: 'd1', request: { subtype: 'request_user_dialog' } }),
    )
    const answers = new Map(
      fake.writes.map((line) => JSON.parse(line)).map((msg) => [msg.response.request_id, msg]),
    )
    expect(answers.get('e1').response.response).toEqual({ action: 'decline' })
    expect(answers.get('h1').response.subtype).toBe('error')
    expect(answers.has('d1')).toBe(false)
    client.close()
  })

  it('ignores stray non-protocol output', async () => {
    const fake = fakeTransport()
    const client = createClaudeStreamClient(fake.transport, {})
    const turn = client.turn('hi', {
      onPartialText: () => {},
      onPermission: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      emit: () => {},
    })
    completeTurn(fake, 'sess-8')
    fake.emitLine('this is not json')
    fake.emitLine(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    await expect(turn.done).resolves.toMatchObject({ output: 'ok' })
  })
})
