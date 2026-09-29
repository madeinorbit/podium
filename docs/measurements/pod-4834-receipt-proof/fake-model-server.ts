import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_LOG!
let n = 0
const textOf = (content: any): string =>
  typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b: any) => b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result ${b.tool_use_id}]` : b.type === 'tool_use' ? `[tool_use ${b.name}]` : `[${b.type}]`).join(' | ')
  : ''
Bun.serve({
  port: Number(process.env.FAKE_PORT),
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    let body: any = undefined
    try { body = await req.json() } catch {}
    const idx = ++n
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    const msgs = (body?.messages ?? []).map((m: any) => ({ role: m.role, text: textOf(m.content).slice(0, 400) }))
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, path: url.pathname, stream: !!body?.stream, hasTools, nMsgs: msgs.length, last3: msgs.slice(-3), full: hasTools ? JSON.stringify(body.messages) : undefined }) + '\n')
    if (!url.pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const enc = new TextEncoder()
    const last = body?.messages?.at(-1)
    const lastText = textOf(last?.content)
    const lastIsToolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
    let mode: 'quick' | 'tool' | 'slow' = 'quick'
    if (hasTools && !lastIsToolResult && lastText.includes('TOOLSLEEP')) mode = 'tool'
    else if (hasTools && !lastIsToolResult && lastText.includes('SLOWTEXT')) mode = 'slow'
    if (!body?.stream) {
      return Response.json({ id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    }
    const stream = new ReadableStream({
      async start(c) {
        const send = (ev: string, data: unknown) => c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
        send('message_start', { type: 'message_start', message: { id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        if (mode === 'tool') {
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake${idx}`, name: 'Bash', input: {} } })
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'sleep 8', description: 'wait eight seconds' }) } })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
        } else {
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          const words = mode === 'slow' ? 20 : 3
          for (let i = 1; i <= words; i++) {
            await Bun.sleep(mode === 'slow' ? 500 : 30)
            send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `r${idx}w${i} ` } })
          }
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: words } })
        }
        send('message_stop', { type: 'message_stop' })
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
