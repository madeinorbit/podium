import { describe, expect, it } from 'vitest'
import type { CodexAuth } from './codex-auth'
import { CodexHttpError, codexComplete, type LlmMessage, type LlmTool } from './llm'

const AUTH: CodexAuth = { accessToken: 'tok-abc', accountId: 'acct-123' }

/** Build a Codex Responses SSE body from final output items. */
function sse(...items: object[]): string {
  const lines = [`event: response.created\ndata: ${JSON.stringify({ type: 'response.created' })}\n`]
  for (const item of items) {
    lines.push(
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item })}\n`,
    )
  }
  lines.push(
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n`,
  )
  return lines.join('\n')
}

function mockFetch(body: string, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return Object.assign(fn, { calls })
}

describe('codexComplete', () => {
  it('parses a text answer from the completed message item', async () => {
    const fetchImpl = mockFetch(
      sse({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello there.' }],
      }),
    )
    const res = await codexComplete(
      fetchImpl,
      AUTH,
      'gpt-5.5',
      [{ role: 'user', content: 'hi' }],
      [],
    )
    expect(res.text).toBe('Hello there.')
    expect(res.toolCalls).toEqual([])
  })

  it('defaults reasoning effort to medium, and honors an explicit effort (#200 B3)', async () => {
    const f1 = mockFetch(
      sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    )
    await codexComplete(f1, AUTH, 'gpt-5.5', [{ role: 'user', content: 'hi' }], [])
    expect(JSON.parse(f1.calls[0]?.init.body as string).reasoning).toEqual({ effort: 'medium' })

    const f2 = mockFetch(
      sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    )
    await codexComplete(f2, AUTH, 'gpt-5.5', [{ role: 'user', content: 'hi' }], [], 'high')
    expect(JSON.parse(f2.calls[0]?.init.body as string).reasoning).toEqual({ effort: 'high' })
  })

  it('extracts function calls with their call_id and arguments', async () => {
    const fetchImpl = mockFetch(
      sse({
        type: 'function_call',
        call_id: 'call_42',
        name: 'list_sessions',
        arguments: '{"x":1}',
      }),
    )
    const res = await codexComplete(
      fetchImpl,
      AUTH,
      'gpt-5.5',
      [{ role: 'user', content: 'go' }],
      [],
    )
    expect(res.toolCalls).toEqual([{ id: 'call_42', name: 'list_sessions', arguments: '{"x":1}' }])
  })

  it('ignores reasoning items and partial-delta events', async () => {
    const body =
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: '{' })}\n\n` +
      `${sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] })}`
    const res = await codexComplete(
      mockFetch(body),
      AUTH,
      'gpt-5.5',
      [{ role: 'user', content: 'x' }],
      [],
    )
    expect(res.text).toBe('done')
    expect(res.toolCalls).toEqual([])
  })

  it('translates history (system → instructions, tool round-trip) and tools to the flat shape', async () => {
    const fetchImpl = mockFetch(
      sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    )
    const tools: LlmTool[] = [
      { name: 'git', description: 'run git', parameters: { type: 'object', properties: {} } },
    ]
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are an orchestrator.' },
      { role: 'user', content: 'status please' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [{ id: 'c1', name: 'git', arguments: '{}' }],
      },
      { role: 'tool', content: 'clean', toolCallId: 'c1', name: 'git' },
    ]
    await codexComplete(fetchImpl, AUTH, 'gpt-5.5', messages, tools)

    const body = JSON.parse(fetchImpl.calls[0]?.init.body as string)
    expect(body.model).toBe('gpt-5.5')
    expect(body.instructions).toBe('You are an orchestrator.')
    expect(body.stream).toBe(true)
    // System excluded from input; user/assistant/function_call/function_call_output preserved in order.
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'status please' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'c1', name: 'git', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'clean' },
    ])
    // Responses API uses a flat function tool shape (no nested `function` wrapper).
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'git',
        description: 'run git',
        parameters: { type: 'object', properties: {} },
      },
    ])
    // Auth lands in the headers the backend requires.
    const headers = fetchImpl.calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-abc')
    expect(headers['chatgpt-account-id']).toBe('acct-123')
  })

  it('throws a CodexHttpError carrying the status on a non-2xx response', async () => {
    const fetchImpl = mockFetch('unauthorized', 401)
    await expect(
      codexComplete(fetchImpl, AUTH, 'gpt-5.5', [{ role: 'user', content: 'hi' }], []),
    ).rejects.toBeInstanceOf(CodexHttpError)
    await expect(
      codexComplete(fetchImpl, AUTH, 'gpt-5.5', [{ role: 'user', content: 'hi' }], []),
    ).rejects.toMatchObject({ status: 401 })
  })
})
