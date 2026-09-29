// POD-4868 fake Anthropic Messages server. Logs every request with its full
// messages (FAKE_LOG). GET /__fail?on=1|0 switches an outage: while on, every
// /v1/messages answers HTTP 500 api_error. Answers, when not failing:
//  - the last user entry containing "continue" in a conversation that holds ALPHA
//    -> a Bash tool call `echo resumed-alpha` (the errored work, resumed);
//  - the last user entry containing NIGHTLY -> a Bash tool call `echo nightly-ran`;
//  - anything else (including a tool_result) -> a short text answer.
// The CLI running the tool call is what "acted on" means here: the fake, not a
// model, decides the answer, so this proves the CLI's path only.
import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_LOG!
let n = 0
let failing = false
const textOf = (content: any): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((b: any) =>
            b.type === 'text' ? b.text
            : b.type === 'tool_result' ? `[tool_result ${JSON.stringify(b.content)}]`
            : b.type === 'tool_use' ? `[tool_use ${b.name} ${JSON.stringify(b.input)}]`
            : `[${b.type}]`,
          )
          .join(' | ')
      : ''
Bun.serve({
  port: Number(process.env.FAKE_PORT),
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/__fail') {
      failing = url.searchParams.get('on') === '1'
      appendFileSync(LOG, JSON.stringify({ at: Date.now(), control: 'fail', failing }) + '\n')
      return Response.json({ failing })
    }
    let body: any
    try { body = await req.json() } catch {}
    const idx = ++n
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    const msgs = (body?.messages ?? []).map((m: any) => ({ role: m.role, text: textOf(m.content) }))
    const isMessages = url.pathname.endsWith('/messages')
    const willFail = isMessages && failing && hasTools
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, path: url.pathname, hasTools, failed: willFail, messages: hasTools ? msgs : undefined }) + '\n')
    if (!isMessages) return Response.json({ input_tokens: 10 })
    if (willFail) {
      return Response.json({ type: 'error', error: { type: 'api_error', message: 'fake outage' } }, { status: 500 })
    }
    // The last USER entry: this Claude build appends a trailing `system` entry
    // (the token budget) after it.
    const last = [...(body?.messages ?? [])].reverse().find((m: any) => m.role === 'user')
    const lastText = textOf(last?.content)
    const lastIsToolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
    const all = msgs.map((m: any) => m.text).join('\n')
    let command: string | null = null
    if (hasTools && !lastIsToolResult && /\bcontinue\b/.test(lastText) && all.includes('ALPHA')) command = 'echo resumed-alpha'
    else if (hasTools && !lastIsToolResult && lastText.includes('NIGHTLY')) command = 'echo nightly-ran'
    if (!body?.stream) {
      return Response.json({ id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    }
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(c) {
        const send = (ev: string, data: unknown) => c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
        send('message_start', { type: 'message_start', message: { id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        if (command) {
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake${idx}`, name: 'Bash', input: {} } })
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'fake step' }) } })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
        } else {
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer r${idx}` } })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
        }
        send('message_stop', { type: 'message_stop' })
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
