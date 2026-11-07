// Fake Anthropic Messages server for POD-6280. Last user text decides:
//   TEXTTOOL -> one message: text block + Bash tool_use (stop tool_use); after the tool result -> final text
//   otherwise -> one streamed text message (end_turn)
import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_LOG!
let n = 0
Bun.serve({
  port: Number(process.env.FAKE_PORT),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    let body: any
    try { body = JSON.parse(await req.text()) } catch {}
    const idx = ++n
    if (!url.pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const msgs = (body?.messages ?? []).filter((m: any) => m.role !== 'system')
    const last = msgs.at(-1)
    const lastIsToolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
    const text = Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : String(last?.content ?? '')
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    const mode = hasTools && !lastIsToolResult && text.includes('TEXTTOOL') ? 'texttool' : 'text'
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, stream: !!body?.stream, hasTools, mode }) + '\n')
    if (!body?.stream) return Response.json({ id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(c) {
        const send = (ev: string, data: unknown) => { try { c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)) } catch {} }
        send('message_start', { type: 'message_start', message: { id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (let i = 1; i <= 4; i++) { await Bun.sleep(40); send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `m${idx}w${i} ` } }) }
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        if (mode === 'texttool') {
          send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_fake${idx}`, name: 'Bash', input: {} } })
          send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'true', description: 'noop' }) } })
          send('content_block_stop', { type: 'content_block_stop', index: 1 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } })
        } else {
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
        }
        send('message_stop', { type: 'message_stop' })
        try { c.close() } catch {}
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
