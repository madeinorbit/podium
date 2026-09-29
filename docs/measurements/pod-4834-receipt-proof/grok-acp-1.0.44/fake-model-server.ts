// Fake model server for the Grok ACP probes (POD-4837): OpenAI chat completions with markers.
// `toolme` -> a run_terminal_command tool call; `slowme` -> 30 slow words; `verylong` -> 27 words 5 s apart
// (a 135 s turn); `fail402` -> HTTP 402. FAKE_PORT, FAKE_WORDS, FAKE_DELAY_MS, FAKE_LOG.
const port = Number(process.env.FAKE_PORT ?? 47311)
const words = Number(process.env.FAKE_WORDS ?? 8)
const delay = Number(process.env.FAKE_DELAY_MS ?? 700)
const logPath = process.env.FAKE_LOG ?? '/dev/stderr'

import { appendFileSync } from 'node:fs'

const log = (s: string) => appendFileSync(logPath, `${new Date().toISOString()} ${s}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const text = Array.from({ length: words }, (_, i) => `w${i + 1}`)
const sse = (obj: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`
Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === 'POST' ? await req.text() : ''
    log(`REQ ${req.method} ${url.pathname} bytes=${body.length}`)
    let parsed: any = {}
    try {
      parsed = JSON.parse(body)
    } catch {}
    if (body.includes('fail402')) {
      log('402')
      return new Response(
        JSON.stringify({
          error: { message: 'Grok Build usage balance exhausted', type: 'payment_required' },
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }
    const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
    if (url.pathname.endsWith('/chat/completions')) {
      const id = 'chatcmpl-fake'
      const msgs: any[] = parsed.messages ?? []
      const last = msgs[msgs.length - 1] ?? {}
      const lastText = JSON.stringify(last.content ?? '')
      if (last.role === 'user' && lastText.includes('toolme')) {
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          start(c) {
            const chunk = (delta: any, finish: string | null = null) =>
              c.enqueue(
                enc.encode(
                  sse({
                    id,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: parsed.model ?? 'fake',
                    choices: [{ index: 0, delta, finish_reason: finish }],
                  }),
                ),
              )
            chunk({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: 'call_probe1',
                  type: 'function',
                  function: { name: 'run_terminal_command', arguments: '' },
                },
              ],
            })
            chunk({
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: JSON.stringify({
                      command: 'echo ZEPHYR > probe.txt',
                      description: 'write probe file',
                    }),
                  },
                },
              ],
            })
            chunk({}, 'tool_calls')
            c.enqueue(enc.encode('data: [DONE]\n\n'))
            log('TOOLCALL')
            c.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      const slow = lastText.includes('slowme')
      const verylong = lastText.includes('verylong')
      const myText = verylong
        ? Array.from({ length: 27 }, (_, i) => `v${i + 1}`)
        : slow
          ? Array.from({ length: 30 }, (_, i) => `s${i + 1}`)
          : text
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder()
          const chunk = (delta: any, finish: string | null = null) =>
            c.enqueue(
              enc.encode(
                sse({
                  id,
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: parsed.model ?? 'fake',
                  choices: [{ index: 0, delta, finish_reason: finish }],
                }),
              ),
            )
          chunk({ role: 'assistant', content: '' })
          for (const w of myText) {
            await sleep(verylong ? 5000 : delay)
            log(`CHUNK chat ${w}`)
            try {
              chunk({ content: `${w} ` })
            } catch {
              log('client gone')
              return
            }
          }
          chunk({}, 'stop')
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          log('DONE chat')
          c.close()
        },
      })
      return new Response(stream, { headers })
    }
    if (url.pathname.endsWith('/responses')) {
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder()
          const send = (type: string, extra: any = {}) =>
            c.enqueue(enc.encode(sse({ type, ...extra }, type)))
          const item = {
            id: 'msg_fake1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [] as any[],
          }
          const resp = {
            id: 'resp_fake',
            object: 'response',
            status: 'in_progress',
            output: [] as any[],
            model: parsed.model ?? 'fake',
          }
          send('response.created', { response: resp })
          send('response.output_item.added', { output_index: 0, item })
          send('response.content_part.added', {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          })
          let full = ''
          for (const w of text) {
            await sleep(delay)
            log(`CHUNK responses ${w}`)
            full += `${w} `
            send('response.output_text.delta', {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: `${w} `,
            })
          }
          send('response.output_text.done', {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text: full,
          })
          send('response.content_part.done', {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: full },
          })
          const done = {
            ...item,
            status: 'completed',
            content: [{ type: 'output_text', text: full }],
          }
          send('response.output_item.done', { output_index: 0, item: done })
          send('response.completed', {
            response: {
              ...resp,
              status: 'completed',
              output: [done],
              usage: { input_tokens: 10, output_tokens: words, total_tokens: 10 + words },
            },
          })
          log('DONE responses')
          c.close()
        },
      })
      return new Response(stream, { headers })
    }
    if (url.pathname.endsWith('/messages') && !url.pathname.includes('count_tokens')) {
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder()
          const send = (type: string, extra: any = {}) =>
            c.enqueue(enc.encode(sse({ type, ...extra }, type)))
          send('message_start', {
            message: {
              id: 'msg_fake',
              type: 'message',
              role: 'assistant',
              model: parsed.model ?? 'fake',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          })
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          for (const w of text) {
            await sleep(delay)
            log(`CHUNK anthropic ${w}`)
            send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${w} ` } })
          }
          send('content_block_stop', { index: 0 })
          send('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: words },
          })
          send('message_stop', {})
          log('DONE anthropic')
          c.close()
        },
      })
      return new Response(stream, { headers })
    }
    if (url.pathname.includes('count_tokens')) return Response.json({ input_tokens: 10 })
    if (url.pathname.endsWith('/models'))
      return Response.json({ object: 'list', data: [{ id: 'fake', object: 'model' }] })
    return Response.json({ ok: true })
  },
})
log(`fake model listening on ${port} words=${words} delay=${delay}`)
