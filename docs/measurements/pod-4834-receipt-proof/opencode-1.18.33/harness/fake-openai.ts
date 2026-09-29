// Fake model server, OpenAI chat-completions SSE (for OpenCode's @ai-sdk/openai-compatible).
// Logs every request with its FULL body. The last user text decides the answer:
//   TOOLSLEEP -> one bash tool call `sleep 8`; SLOWTEXT -> 20 words over 10 s; else 3 quick words.
// A request whose last message is a tool result always gets quick text.
import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_LOG!
let n = 0
const textOf = (content: any): string =>
  typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b: any) => b.type === 'text' ? b.text : `[${b.type}]`).join(' | ')
  : ''
Bun.serve({
  port: Number(process.env.FAKE_PORT),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const raw = req.method === 'POST' ? await req.text() : ''
    let body: any = undefined
    try { body = JSON.parse(raw) } catch {}
    const idx = ++n
    const at = Date.now()
    const msgs: any[] = body?.messages ?? []
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    const last = msgs.at(-1)
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    const lastText = last?.role === 'user' ? textOf(last.content) : ''
    let mode: 'quick' | 'tool' | 'slow' = 'quick'
    if (hasTools && last?.role === 'user' && lastText.includes('TOOLSLEEP')) mode = 'tool'
    else if (hasTools && last?.role === 'user' && lastText.includes('SLOWTEXT')) mode = 'slow'
    appendFileSync(LOG, JSON.stringify({
      at, idx, method: req.method, path: url.pathname, stream: !!body?.stream, hasTools, mode, toolNames: (body?.tools ?? []).map((t: any) => t.function?.name),
      nMsgs: msgs.length, lastRole: last?.role,
      users: msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content).slice(0, 300)),
      messages: msgs.map((m) => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id })),
    }) + '\n')
    if (!url.pathname.endsWith('/chat/completions')) return Response.json({ data: [] })
    // MODEL400: an explicit error reply from the model (not retryable).
    if (hasTools && last?.role === 'user' && lastText.includes('MODEL400')) return Response.json({ error: { message: 'fake model refuses MODEL400', type: 'invalid_request_error' } }, { status: 400 })
    const enc = new TextEncoder()
    const model = body?.model ?? 'fake'
    const stream = new ReadableStream({
      async start(c) {
        const chunk = (delta: any, finish: string | null = null) =>
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: `chatcmpl-${idx}`, object: 'chat.completion.chunk', created: Math.floor(at / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`))
        chunk({ role: 'assistant', content: '' })
        if (mode === 'tool') {
          // The shell tool: `bash` on 1.18.33; otherwise the first tool whose name says shell/bash/exec.
          const names: string[] = (body?.tools ?? []).map((t: any) => t.function?.name)
          const tool = names.includes('bash') ? 'bash' : names.find((n) => /shell|bash|exec|command/i.test(n)) ?? 'bash'
          const params = (body?.tools ?? []).find((t: any) => t.function?.name === tool)?.function?.parameters
          const args: any = { command: 'sleep 8', description: 'wait eight seconds' }
          if (params?.properties && !('description' in params.properties)) delete args.description
          chunk({ tool_calls: [{ index: 0, id: `call_fake${idx}`, type: 'function', function: { name: tool, arguments: '' } }] })
          chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
          chunk({}, 'tool_calls')
        } else {
          const words = mode === 'slow' ? 20 : 3
          for (let i = 1; i <= words; i++) {
            await Bun.sleep(mode === 'slow' ? 500 : 20)
            try { chunk({ content: `r${idx}w${i} ` }) } catch { return }
          }
          chunk({}, 'stop')
        }
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: `chatcmpl-${idx}`, object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  },
})
console.error(`fake-openai on ${process.env.FAKE_PORT}`)
