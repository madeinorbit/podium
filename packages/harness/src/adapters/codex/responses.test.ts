/**
 * Codex Responses wire (POD-4750) — moved verbatim from
 * `apps/server/src/llm.test.ts`'s `codexComplete` suite so the move of WHERE
 * the HTTPS call runs is proven byte-identical: same body shape, same headers,
 * same SSE fold. The fetch + auth-file halves now live in the daemon's
 * control handler (`apps/daemon/src/control/codex.ts`); only the pure wire is
 * pinned here.
 */
import { describe, expect, it } from 'vitest'
import {
  buildCodexResponsesBody,
  type CodexLlmMessage,
  type CodexLlmTool,
  codexResponsesHeaders,
  CodexHttpError,
  parseCodexResponsesSse,
  toCodexResponsesInput,
} from './responses'

const AUTH = { accessToken: 'tok-abc', accountId: 'acct-123' }

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

describe('parseCodexResponsesSse', () => {
  it('parses a text answer from the completed message item', () => {
    const res = parseCodexResponsesSse(
      sse({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello there.' }],
      }),
    )
    expect(res.text).toBe('Hello there.')
    expect(res.toolCalls).toEqual([])
  })

  it('extracts function calls with their call_id and arguments', () => {
    const res = parseCodexResponsesSse(
      sse({
        type: 'function_call',
        call_id: 'call_42',
        name: 'list_sessions',
        arguments: '{"x":1}',
      }),
    )
    expect(res.toolCalls).toEqual([{ id: 'call_42', name: 'list_sessions', arguments: '{"x":1}' }])
  })

  it('ignores reasoning items and partial-delta events', () => {
    const body =
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: '{' })}\n\n` +
      `${sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] })}`
    const res = parseCodexResponsesSse(body)
    expect(res.text).toBe('done')
    expect(res.toolCalls).toEqual([])
  })

  it('throws the backend failure when the stream carries no output', () => {
    const body = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: 'billing hard limit' } } })}\n`
    expect(() => parseCodexResponsesSse(body)).toThrow('billing hard limit')
  })
})

describe('buildCodexResponsesBody', () => {
  it('defaults reasoning effort to medium, and honors an explicit effort', () => {
    expect(
      buildCodexResponsesBody('gpt-5.5', [{ role: 'user', content: 'hi' }], []).reasoning,
    ).toEqual({ effort: 'medium' })
    expect(
      buildCodexResponsesBody('gpt-5.5', [{ role: 'user', content: 'hi' }], [], 'high').reasoning,
    ).toEqual({ effort: 'high' })
  })

  it('translates history (system → instructions, tool round-trip) and tools to the flat shape', () => {
    const tools: CodexLlmTool[] = [
      { name: 'git', description: 'run git', parameters: { type: 'object', properties: {} } },
    ]
    const messages: CodexLlmMessage[] = [
      { role: 'system', content: 'You are an orchestrator.' },
      { role: 'user', content: 'status please' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [{ id: 'c1', name: 'git', arguments: '{}' }],
      },
      { role: 'tool', content: 'clean', toolCallId: 'c1', name: 'git' },
    ]
    const body = buildCodexResponsesBody('gpt-5.5', messages, tools)
    expect(body.model).toBe('gpt-5.5')
    expect(body.instructions).toBe('You are an orchestrator.')
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
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
  })

  it('pins the exact body bytes for a fixed turn (wire-format golden)', () => {
    const body = buildCodexResponsesBody(
      'gpt-5.5',
      [
        { role: 'system', content: 'You are an orchestrator.' },
        { role: 'user', content: 'hi' },
      ],
      [],
    )
    // Field order matters: zod-free JSON here, so this pins what the old
    // server code sent byte for byte.
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: 'gpt-5.5',
        instructions: 'You are an orchestrator.',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ],
        reasoning: { effort: 'medium' },
        stream: true,
        store: false,
      }),
    )
  })
})

describe('codexResponsesHeaders', () => {
  it('auth lands in the headers the backend requires', () => {
    const headers = codexResponsesHeaders(AUTH)
    expect(headers.authorization).toBe('Bearer tok-abc')
    expect(headers['chatgpt-account-id']).toBe('acct-123')
    expect(headers.originator).toBe('codex_cli_rs')
  })
})

describe('toCodexResponsesInput', () => {
  it('joins system messages into instructions and drops them from input', () => {
    const { instructions, input } = toCodexResponsesInput([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'hi' },
    ])
    expect(instructions).toBe('a\n\nb')
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
  })
})

describe('CodexHttpError', () => {
  it('carries the status', () => {
    expect(new CodexHttpError(401, 'unauthorized').status).toBe(401)
  })
})
