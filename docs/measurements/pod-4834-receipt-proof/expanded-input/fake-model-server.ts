// Byte-preserving fake for the long-input measurements. Based on the Phase B
// codex/tools/fake-responses-server.ts and opencode/harness/fake-openai.ts.
// No tools, no truncation: full non-system input and the raw HTTP-body digest are evidence.
import { appendFileSync } from 'node:fs'
import { bytes, sha } from './matrix.ts'

const port = Number(process.env.FAKE_PORT)
const log = (row: unknown) => appendFileSync(process.env.FAKE_LOG!, JSON.stringify(row) + '\n')
let seq = 0
Bun.serve({
  hostname: '127.0.0.1', port, idleTimeout: 120,
  async fetch(req) {
    const raw = req.method === 'POST' ? await req.text() : ''
    const body = raw ? JSON.parse(raw) : {}
    const path = new URL(req.url).pathname
    const n = ++seq, at = Date.now()
    const messages = (body.messages ?? body.input ?? []).filter((m: any) =>
      m.role !== 'system' && m.role !== 'developer')
    log({ at, n, path, method: req.method, stream: body.stream, model: body.model,
      rawBytes: bytes(raw), rawSha256: sha(raw), messages })
    if (path.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fake', object: 'model' }] })
    if (!path.endsWith('/responses') && !path.endsWith('/chat/completions')) return Response.json({ ok: true })
    const answer = `ok-${n}`
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (!path.endsWith('/responses') && !body.stream) return Response.json({
      id: `chatcmpl-${n}`, object: 'chat.completion', created: Math.floor(at / 1000), model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage,
    })
    const data: string[] = []
    const emit = (type: string, extra: any) => data.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`)
    if (path.endsWith('/responses')) {
      const item = { id: `msg_fake${n}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
      const response = { id: `resp_fake${n}`, object: 'response', status: 'in_progress', output: [], model: body.model }
      const part = { type: 'output_text', text: answer, annotations: [] }
      emit('response.created', { response })
      emit('response.output_item.added', { output_index: 0, item })
      emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } })
      emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: answer })
      emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: answer })
      emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part })
      const complete = { ...item, status: 'completed', content: [part] }
      emit('response.output_item.done', { output_index: 0, item: complete })
      emit('response.completed', { response: { ...response, status: 'completed', output: [complete],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    } else {
      const chunk = (delta: any, finish_reason: string | null = null) => data.push(`data: ${JSON.stringify({
        id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: Math.floor(at / 1000), model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`)
      chunk({ role: 'assistant', content: '' }); chunk({ content: answer }); chunk({}, 'stop')
      data.push(`data: ${JSON.stringify({ id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: Math.floor(at / 1000), model: body.model, choices: [], usage })}\n\ndata: [DONE]\n\n`)
    }
    return new Response(data.join(''), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  },
})
log({ at: Date.now(), listening: port })
