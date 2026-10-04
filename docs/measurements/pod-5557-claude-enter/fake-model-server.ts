import { appendFileSync, existsSync, unlinkSync } from 'node:fs'

const port = Number(process.env.FAKE_PORT)
const log = process.env.FAKE_LOG!
const releaseFile = process.env.FAKE_RELEASE!
let next = 'quick'
let held = false
let sequence = 0
const write = (row: unknown) => appendFileSync(log, `${JSON.stringify(row)}\n`)
const textOf = (content: any): string => typeof content === 'string' ? content
  : (content ?? []).map((block: any) => block.text ?? (block.type === 'tool_result' ? '[tool_result]' : '')).join('\n')

Bun.serve({
  hostname: '127.0.0.1', port, idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/control') {
      const control = await request.json() as { next?: string; release?: boolean }
      if (control.next) {
        next = control.next
        held = false
        if (existsSync(releaseFile)) unlinkSync(releaseFile)
      }
      if (control.release) held = false
      write({ at: Date.now(), control })
      return Response.json({ next, held })
    }
    if (url.pathname === '/health') return Response.json({ pid: process.pid, port, held, next })
    let body: any
    try { body = await request.json() } catch { body = {} }
    if (!url.pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const id = ++sequence
    const last = [...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user')
    const toolResult = Array.isArray(last?.content) && last.content.some((block: any) => block.type === 'tool_result')
    // Claude also calls the model for its session title. That background request
    // must never consume the next main-turn scenario or release its stream.
    const main = !!body.tools?.length || (next === 'compacting' && !textOf(last?.content).includes('Write the title'))
    const mode = !main || (toolResult && next !== 'compacting') ? 'quick' : next
    if (main) next = 'quick'
    if (mode === 'streaming' || mode === 'compacting') held = true
    write({ at: Date.now(), id, mode, stream: body.stream, hasTools: !!body.tools?.length,
      lastUser: textOf(last?.content), system: JSON.stringify(body.system).slice(0, 200) })
    const answer = mode === 'compacting' ? 'Synthetic summary of the scratch conversation.' : `fake answer ${id}`
    if (!body.stream) {
      while (mode === 'compacting' && held) await Bun.sleep(25)
      write({ at: Date.now(), id, finished: true })
      return Response.json({ id: `msg_fake_${id}`, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        try {
          send('message_start', { type: 'message_start', message: { id: `msg_fake_${id}`, type: 'message', role: 'assistant',
            model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
          if (mode === 'tool') {
            send('content_block_start', { type: 'content_block_start', index: 0,
              content_block: { type: 'tool_use', id: `toolu_fake_${id}`, name: 'Bash', input: {} } })
            send('content_block_delta', { type: 'content_block_delta', index: 0,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `until test -e '${releaseFile}'; do sleep 0.05; done`,
                description: 'Wait for the local measurement release file' }) } })
          } else {
            send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
            send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } })
            while ((mode === 'streaming' || mode === 'compacting') && held) {
              await Bun.sleep(150)
              if (mode === 'streaming') send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' stream' } })
            }
          }
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: mode === 'tool' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
          send('message_stop', { type: 'message_stop' })
          controller.close()
          write({ at: Date.now(), id, finished: true })
        } catch (error) { write({ at: Date.now(), id, closed: String(error) }) }
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
console.log(JSON.stringify({ pid: process.pid, port }))
