// Fake Anthropic Messages server. Logs every request with its FULL body.
// Markers in the last user text: TOOLSLEEP (Bash sleep 8), SLOWTEXT (10 s of streamed text),
// BGTASK (a background Bash sleep 3), ERR400 (explicit 400 reply), HANGFIRST (first byte after 6 s).
import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_LOG!
let n = 0
const textOf = (content: any): string =>
  typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b: any) => b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result ${b.tool_use_id}: ${textOf(b.content)}]` : b.type === 'tool_use' ? `[tool_use ${b.name}]` : `[${b.type}]`).join(' | ')
  : ''
Bun.serve({
  port: Number(process.env.FAKE_PORT),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const raw = await req.text()
    let body: any = undefined
    try { body = JSON.parse(raw) } catch {}
    const idx = ++n
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    const msgs = (body?.messages ?? []).map((m: any) => ({ role: m.role, text: textOf(m.content) }))
    // This CLI appends role:'system' messages after the user turn; the marker is read from the last non-system message.
    const last = (body?.messages ?? []).filter((m: any) => m.role !== 'system').at(-1)
    const lastText = textOf(last?.content)
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, path: url.pathname, stream: !!body?.stream, hasTools, nMsgs: msgs.length, lastText: lastText.slice(-1500), messages: body?.messages, system: typeof body?.system === 'string' ? body.system.slice(0, 200) : undefined }) + '\n')
    if (!url.pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const lastIsToolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
    // Only the latest user text decides; text inside a tool_result never triggers a marker.
    const freshText = Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : lastText
    if (hasTools && freshText.includes('ERR400')) {
      appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, reply: 400 }) + '\n')
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'fake: rejected by test (ERR400)' } }, { status: 400 })
    }
    let mode: 'quick' | 'tool' | 'slow' | 'bg' = 'quick'
    if (hasTools && !lastIsToolResult && freshText.includes('TOOLSLEEP')) mode = 'tool'
    else if (hasTools && !lastIsToolResult && freshText.includes('SLOWTEXT')) mode = 'slow'
    else if (hasTools && !lastIsToolResult && freshText.includes('BGTASK')) mode = 'bg'
    const hang = hasTools && freshText.includes('HANGFIRST')
    if (!body?.stream) {
      return Response.json({ id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    }
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(c) {
        const send = (ev: string, data: unknown) => { try { c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)) } catch {} }
        if (hang) await Bun.sleep(6000)
        send('message_start', { type: 'message_start', message: { id: `msg_fake${idx}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        if (mode === 'tool' || mode === 'bg') {
          const input = mode === 'tool' ? { command: 'sleep 8', description: 'wait eight seconds' } : { command: 'sleep 3', description: 'background wait', run_in_background: true }
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fake${idx}`, name: 'Bash', input: {} } })
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
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
        try { c.close() } catch {}
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
