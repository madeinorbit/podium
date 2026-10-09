// Local fake model for POD-5923. Answers Anthropic /v1/messages and OpenAI
// /v1/responses + /v1/chat/completions with a fixed text reply. No tools, no
// network. Image payloads are logged as media type + byte count + digest only.

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const port = Number(process.env.FAKE_PORT)
const logFile = process.env.FAKE_LOG!
const log = (row: unknown) => appendFileSync(logFile, `${JSON.stringify(row)}\n`)
let seq = 0

/** Replace every long base64 string (image data, data: URLs) with its size and digest. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 512 && /^(data:[^,]+,)?[A-Za-z0-9+/=\s]+$/.test(value))
      return `<base64 ${value.length} chars sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}>`
    return value.length > 4000 ? `${value.slice(0, 4000)}…<${value.length} chars>` : value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]))
  return value
}

/** Stream what is ready now, hold 8 s, then the rest that `finish` appends. */
function slowSse(out: string[], finish: () => void): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(out.splice(0).join('')))
        await Bun.sleep(8000)
        finish()
        controller.enqueue(encoder.encode(out.splice(0).join('')))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
  )
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ pid: process.pid, port })
    const raw = request.method === 'POST' ? await request.text() : ''
    let body: any = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {}
    const n = ++seq
    const at = Date.now()
    const path = url.pathname
    const messages = (body.messages ?? body.input ?? [])
      .filter((m: any) => m?.role === 'user')
      .slice(-1)
    log({ at, n, path, stream: body.stream, model: body.model, lastUser: redact(messages) })
    const answer = `fake answer ${n}`
    // A prompt containing SLOWSETUP holds its streamed reply for 8 s: the
    // program is busy while the next case is typed.
    const slow = JSON.stringify(messages).includes('SLOWSETUP')
    const sse = (chunks: string[]) =>
      new Response(chunks.join(''), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    if (path.endsWith('/models'))
      return Response.json({ object: 'list', data: [{ id: 'fake', object: 'model' }] })
    if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
    if (path.endsWith('/messages')) {
      if (!body.stream)
        return Response.json({
          id: `msg_fake_${n}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: answer }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      const out: string[] = []
      const send = (event: string, data: unknown) =>
        out.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', {
        type: 'message_start',
        message: {
          id: `msg_fake_${n}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: answer },
      })
      if (slow)
        return slowSse(out, () => {
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5 },
          })
          send('message_stop', { type: 'message_stop' })
        })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      })
      send('message_stop', { type: 'message_stop' })
      return sse(out)
    }
    if (path.endsWith('/responses')) {
      const out: string[] = []
      const emit = (type: string, extra: any) =>
        out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`)
      const item = {
        id: `msg_fake${n}`,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }
      const response = {
        id: `resp_fake${n}`,
        object: 'response',
        status: 'in_progress',
        output: [],
        model: body.model,
      }
      const part = { type: 'output_text', text: answer, annotations: [] }
      emit('response.created', { response })
      emit('response.output_item.added', { output_index: 0, item })
      emit('response.content_part.added', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: '' },
      })
      emit('response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: answer,
      })
      const finish = () => {
        emit('response.output_text.done', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: answer,
        })
        emit('response.content_part.done', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part,
        })
        const complete = { ...item, status: 'completed', content: [part] }
        emit('response.output_item.done', { output_index: 0, item: complete })
        emit('response.completed', {
          response: {
            ...response,
            status: 'completed',
            output: [complete],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        })
      }
      if (slow) return slowSse(out, finish)
      finish()
      return sse(out)
    }
    if (path.endsWith('/chat/completions')) {
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (!body.stream)
        return Response.json({
          id: `chatcmpl-${n}`,
          object: 'chat.completion',
          created: Math.floor(at / 1000),
          model: body.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
          ],
          usage,
        })
      const out: string[] = []
      const chunk = (delta: any, finish_reason: string | null = null) =>
        out.push(
          `data: ${JSON.stringify({
            id: `chatcmpl-${n}`,
            object: 'chat.completion.chunk',
            created: Math.floor(at / 1000),
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        )
      chunk({ role: 'assistant', content: '' })
      chunk({ content: answer })
      const finish = () => {
        chunk({}, 'stop')
        out.push(
          `data: ${JSON.stringify({ id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: Math.floor(at / 1000), model: body.model, choices: [], usage })}\n\ndata: [DONE]\n\n`,
        )
      }
      if (slow) return slowSse(out, finish)
      finish()
      return sse(out)
    }
    return Response.json({ ok: true })
  },
})
log({ at: Date.now(), listening: port, pid: process.pid })
