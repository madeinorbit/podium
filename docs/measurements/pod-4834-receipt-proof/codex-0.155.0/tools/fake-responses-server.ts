// Fake OpenAI Responses server for codex-cli 0.155.0 (POD-4863). Logs every request with its
// full `input` (instructions and tool schemas are replaced by their length and hash; they are
// Codex's own prompt, not message content). Markers, read from the LAST input item only when it
// is a user message:
//   TOOLSLEEP  -> one tool call running `sleep 8`
//   SLOWTEXT   -> 10 s of streamed text, no tool call
//   HTTP400    -> an HTTP 400 error reply
//   TOOLBG     -> one tool call running `sleep 6` that yields after 500 ms (a background terminal)
//   anything else, or a last item that is a tool output -> a short quick text reply
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const LOG = process.env.FAKE_LOG!
const PORT = Number(process.env.FAKE_PORT)
let n = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const log = (o: unknown) => appendFileSync(LOG, `${JSON.stringify(o)}\n`)
const textOf = (item: any): string =>
  Array.isArray(item?.content) ? item.content.map((c: any) => c.text ?? `[${c.type}]`).join('') : ''

function toolCall(tools: string[], bg = false) {
  if (bg) return { name: 'exec_command', args: { cmd: 'sleep 6', yield_time_ms: 500 } }
  if (tools.includes('exec_command')) return { name: 'exec_command', args: { cmd: 'sleep 8', yield_time_ms: 10000 } }
  if (tools.includes('shell_command')) return { name: 'shell_command', args: { command: 'sleep 8' } }
  return { name: 'shell', args: { command: ['bash', '-lc', 'sleep 8'] } }
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const raw = req.method === 'POST' ? await req.text() : ''
    let body: any = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const idx = ++n
    const at = Date.now()
    const tools: string[] = (body.tools ?? []).map((t: any) => t.name ?? t.type)
    const input: any[] = Array.isArray(body.input) ? body.input : []
    const last = input.at(-1)
    const lastIsUser = last?.type === 'message' && last?.role === 'user'
    const lastText = lastIsUser ? textOf(last) : ''
    let mode: 'quick' | 'tool' | 'toolbg' | 'slow' | 'http400' = 'quick'
    if (lastIsUser && lastText.includes('TOOLSLEEP')) mode = 'tool'
    else if (lastIsUser && lastText.includes('TOOLBG')) mode = 'toolbg'
    else if (lastIsUser && lastText.includes('SLOWTEXT')) mode = 'slow'
    else if (lastIsUser && lastText.includes('HTTP400')) mode = 'http400'
    log({
      at,
      idx,
      method: req.method,
      path: url.pathname,
      mode,
      instructions: typeof body.instructions === 'string' ? { len: body.instructions.length, sha: hash(body.instructions) } : undefined,
      tools,
      previous_response_id: body.previous_response_id,
      input,
    })
    if (!url.pathname.endsWith('/responses')) {
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fake', object: 'model' }] })
      return Response.json({ ok: true })
    }
    if (mode === 'http400') {
      log({ at: Date.now(), idx, event: 'reply-http400' })
      return Response.json({ error: { message: 'fake: bad request (HTTP400 marker)', type: 'invalid_request_error', code: 'fake_400' } }, { status: 400 })
    }
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(c) {
        const send = (type: string, extra: any = {}) => c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`))
        const resp = { id: `resp_fake${idx}`, object: 'response', status: 'in_progress', output: [] as any[], model: body.model ?? 'fake' }
        send('response.created', { response: resp })
        let out: any
        if (mode === 'tool' || mode === 'toolbg') {
          const t = toolCall(tools, mode === 'toolbg')
          const args = JSON.stringify(t.args)
          out = { id: `fc_fake${idx}`, type: 'function_call', status: 'completed', name: t.name, call_id: `call_fake${idx}`, arguments: args }
          send('response.output_item.added', { output_index: 0, item: { ...out, status: 'in_progress', arguments: '' } })
          send('response.function_call_arguments.delta', { item_id: out.id, output_index: 0, delta: args })
          send('response.function_call_arguments.done', { item_id: out.id, output_index: 0, arguments: args })
          send('response.output_item.done', { output_index: 0, item: out })
        } else {
          const words = mode === 'slow' ? Array.from({ length: 20 }, (_, i) => `slow${i + 1}`) : [`ok${idx}`]
          const gap = mode === 'slow' ? 500 : 0
          const item = { id: `msg_fake${idx}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] as any[] }
          send('response.output_item.added', { output_index: 0, item })
          send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
          let full = ''
          for (const w of words) {
            if (gap) await sleep(gap)
            full += `${w} `
            send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: `${w} ` })
          }
          send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: full })
          send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: full, annotations: [] } })
          out = { ...item, status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] }
          send('response.output_item.done', { output_index: 0, item: out })
        }
        send('response.completed', { response: { ...resp, status: 'completed', output: [out], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } })
        log({ at: Date.now(), idx, event: 'stream-done', mode })
        try {
          c.close()
        } catch {}
      },
      cancel() {
        log({ at: Date.now(), idx, event: 'stream-cancelled-by-client' })
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  },
})
log({ at: Date.now(), event: 'listening', port: PORT })
