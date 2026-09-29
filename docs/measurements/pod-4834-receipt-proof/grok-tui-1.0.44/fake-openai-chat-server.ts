// Fake model server, OpenAI chat-completions SSE (the wire Grok 1.0.44 uses for a custom
// `[model.x] base_url`). Every request is logged with its full non-system messages.
// Markers in the newest user message pick the reply:
//   TOOLSLEEP -> one run_terminal_command `sleep 8` tool call
//   SLOWTEXT  -> 20 words streamed 500 ms apart (10 s), no tool call
//   ERRORNOW  -> HTTP 400 with an OpenAI error body
// A compaction request ("produce a faithful, concise summary") -> a <summary> block with all 9 sections.
// Anything else (and every request whose last message is a tool result) -> 3 quick words.
import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_LOG!
let n = 0
const textOf = (content: any): string =>
  typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b: any) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' | ')
  : ''
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
Bun.serve({
  port: Number(process.env.FAKE_PORT),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const raw = req.method === 'POST' ? await req.text() : ''
    // Podium's installed Grok hook (PODIUM_GROK_HOOK_URL) posts here; log it as-is.
    if (url.pathname === '/podium-hook') {
      appendFileSync(process.env.PODIUM_HOOK_LOG!, JSON.stringify({ at: Date.now(), payload: JSON.parse(raw || 'null') }) + '\n')
      return Response.json({})
    }
    let body: any = {}
    try { body = JSON.parse(raw) } catch {}
    const idx = ++n
    const at = Date.now()
    const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
    const logged = messages.map((m: any) =>
      m.role === 'system' ? { role: 'system', chars: textOf(m.content).length }
      : { role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id })
    appendFileSync(LOG, JSON.stringify({ at, idx, method: req.method, path: url.pathname, model: body?.model, stream: !!body?.stream, nTools: Array.isArray(body?.tools) ? body.tools.length : 0, messages: logged }) + '\n')
    if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fake', object: 'model' }] })
    if (!url.pathname.endsWith('/chat/completions')) return Response.json({ ok: true })
    const last = messages.at(-1)
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
    const lastUserText = textOf(lastUser?.content)
    const lastIsUser = last?.role === 'user'
    let mode: 'quick' | 'tool' | 'slow' | 'error' | 'summary' = 'quick'
    if (lastIsUser && textOf(last?.content).includes('produce a faithful, concise summary')) mode = 'summary'
    else if (lastIsUser && lastUserText.includes('ERRORNOW')) mode = 'error'
    else if (lastIsUser && lastUserText.includes('TOOLSLEEP')) mode = 'tool'
    else if (lastIsUser && lastUserText.includes('SLOWTEXT')) mode = 'slow'
    if (mode === 'error') {
      appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, reply: 'error-400' }) + '\n')
      return Response.json({ error: { message: 'fake: rejected on purpose', type: 'invalid_request_error', code: 'fake_error' } }, { status: 400 })
    }
    const id = `chatcmpl-fake${idx}`
    const stream = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder()
        const chunk = (delta: any, finish: string | null = null) =>
          c.enqueue(enc.encode(sse({ id, object: 'chat.completion.chunk', created: Math.floor(at / 1000), model: body.model ?? 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })))
        chunk({ role: 'assistant', content: '' })
        if (mode === 'tool') {
          chunk({ tool_calls: [{ index: 0, id: `call_fake${idx}`, type: 'function', function: { name: 'run_terminal_command', arguments: '' } }] })
          chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'sleep 8', description: 'wait eight seconds' }) } }] })
          chunk({}, 'tool_calls')
        } else if (mode === 'summary') {
          const sections = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code Sections', 'Errors and Fixes', 'Problem Solving', 'All User Messages', 'Pending Tasks', 'Current Work', 'Optional Next Step']
          chunk({ content: `<summary>\n${sections.map((t, i) => `${i + 1}. ${t}: fake summary section ${i + 1} for measurement.`).join('\n')}\n</summary>` })
          chunk({}, 'stop')
        } else {
          const words = mode === 'slow' ? 20 : 3
          for (let i = 1; i <= words; i++) {
            await Bun.sleep(mode === 'slow' ? 500 : 30)
            chunk({ content: `r${idx}w${i} ` })
          }
          chunk({}, 'stop')
        }
        c.enqueue(enc.encode(sse({ id, object: 'chat.completion.chunk', created: Math.floor(at / 1000), model: body.model ?? 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        appendFileSync(LOG, JSON.stringify({ at: Date.now(), idx, reply: mode, done: true }) + '\n')
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  },
})
