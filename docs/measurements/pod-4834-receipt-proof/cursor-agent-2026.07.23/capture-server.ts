// Capture server for cursor-agent's --endpoint (CURSOR_API_ENDPOINT). Logs every request
// (method, path, headers with secrets redacted, body size, printable strings of the body).
// It is NOT a model: Cursor speaks its own Connect/protobuf protocol, and no reply here makes
// the agent run a turn. Replies:
//   /auth/exchange_user_api_key -> a made-up local token pair (an unsigned JWT; not a credential)
//   Connect streaming (application/connect+*) -> an end-of-stream frame with error "unavailable"
//   GetUsableModels / GetDefaultModelForCli -> one made-up model "fake-model" (agent.v1.ModelDetails,
//     field numbers read from the bundle), so the TUI reaches its prompt
//   anything else -> 200 with an empty body (an empty protobuf = the default message)
import { appendFileSync } from 'node:fs'
const LOG = process.env.CAP_LOG!
const printable = (b: Uint8Array) => (new TextDecoder('utf-8', { fatal: false }).decode(b).match(/[\x20-\x7e -￿]{4,}/g) ?? []).slice(0, 80)
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
// Minimal protobuf encoding: length-delimited fields only.
const varint = (n: number) => { const o: number[] = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7 } o.push(n); return o }
const field = (no: number, bytes: Uint8Array) => new Uint8Array([...varint((no << 3) | 2), ...varint(bytes.length), ...bytes])
const str = (s: string) => new TextEncoder().encode(s)
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length } return o }
const modelDetails = cat(field(1, str('fake-model')), field(3, str('fake-model')), field(4, str('Fake Model')), field(5, str('Fake')))
const fakeJwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'auth0|fake-local-user', exp: 4102444800, iat: 1790000000 })}.fake`
Bun.serve({
  port: Number(process.env.CAP_PORT),
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    const body = new Uint8Array(await req.arrayBuffer())
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = /authorization|cookie|token|key|checksum/i.test(k) ? '<redacted>' : v })
    const ct = req.headers.get('content-type') ?? ''
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), method: req.method, path: url.pathname, headers, bytes: body.length, strings: printable(body) }) + '\n')
    if (url.pathname === '/auth/exchange_user_api_key') return Response.json({ accessToken: fakeJwt, refreshToken: fakeJwt, authId: 'auth0|fake-local-user' })
    if (url.pathname.endsWith('/GetUsableModels') || url.pathname.endsWith('/GetDefaultModelForCli'))
      return new Response(field(1, modelDetails), { status: 200, headers: { 'content-type': 'application/proto' } })
    if (ct.startsWith('application/connect+')) {
      const end = new TextEncoder().encode(JSON.stringify({ error: { code: 'unavailable', message: 'capture server: no model here' } }))
      const frame = new Uint8Array(5 + end.length)
      frame[0] = 2
      new DataView(frame.buffer).setUint32(1, end.length)
      frame.set(end, 5)
      return new Response(frame, { status: 200, headers: { 'content-type': ct } })
    }
    return new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': ct || 'application/proto' } })
  },
})
