import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { type McpToolProvider, registerMcpRoute } from './mcp-route'

const TOKEN = 'secret-token'

const provider: McpToolProvider = {
  mcpToolSpecs: () => [
    {
      name: 'list_sessions',
      description: 'List sessions',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  callMcpTool: async (name, args) => {
    if (name === 'boom') throw new Error('kaboom')
    return `ran ${name} with ${JSON.stringify(args)}`
  },
}

function app(): Hono {
  const a = new Hono()
  registerMcpRoute(a, provider, TOKEN)
  return a
}

interface RpcResponse {
  result?: {
    protocolVersion?: string
    capabilities?: { tools?: unknown }
    tools?: Array<{ name: string; inputSchema?: unknown }>
    content?: Array<{ text: string }>
    isError?: boolean
  }
  error?: { code: number; message: string }
}

function rpc(method: string, params?: unknown, token = TOKEN) {
  return app().request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-podium-mcp-token': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

const json = async (res: Response): Promise<RpcResponse> => (await res.json()) as RpcResponse

describe('registerMcpRoute', () => {
  it('rejects a missing/wrong token', async () => {
    const res = await rpc('tools/list', undefined, 'wrong')
    expect(res.status).toBe(401)
  })

  it('handles initialize', async () => {
    const body = await json(await rpc('initialize'))
    expect(body.result?.protocolVersion).toBeDefined()
    expect(body.result?.capabilities?.tools).toBeDefined()
  })

  it('lists tools', async () => {
    const body = await json(await rpc('tools/list'))
    expect(body.result?.tools?.[0]?.name).toBe('list_sessions')
    expect(body.result?.tools?.[0]?.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('calls a tool and returns its text content', async () => {
    const body = await json(await rpc('tools/call', { name: 'list_sessions', arguments: { a: 1 } }))
    expect(body.result?.content?.[0]?.text).toBe('ran list_sessions with {"a":1}')
    expect(body.result?.isError).toBeUndefined()
  })

  it('reports a tool error as isError content, not a transport failure', async () => {
    const res = await rpc('tools/call', { name: 'boom' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toContain('kaboom')
  })

  it('acknowledges notifications with 202 and no body', async () => {
    const res = await rpc('notifications/initialized')
    expect(res.status).toBe(202)
  })
})

// Streamable-HTTP transport handshake (POD-1021): modern MCP clients (codex
// 0.144.5's rmcp) open the connection with `GET /mcp` looking for a
// server-initiated SSE stream. Podium is POST-only JSON-RPC, so the spec's
// answer is 405 — without it the GET 404s and rmcp mis-reads that as an OAuth
// challenge, dying with `Auth(AuthorizationRequired)` and killing the turn.
describe('registerMcpRoute streamable-HTTP handshake', () => {
  it('answers GET /mcp with 405 + Allow: POST so a client falls back to POST', async () => {
    const res = await app().request('/mcp', {
      method: 'GET',
      headers: { 'x-podium-mcp-token': TOKEN },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('POST')
  })

  it('answers DELETE /mcp with 405 (no client-driven session termination)', async () => {
    const res = await app().request('/mcp', {
      method: 'DELETE',
      headers: { 'x-podium-mcp-token': TOKEN },
    })
    expect(res.status).toBe(405)
  })
})

// Thread identity (issue #67): the route resolves the opaque x-podium-mcp-thread
// token server-side and passes the threadId into callMcpTool.
describe('registerMcpRoute thread identity', () => {
  function threadApp() {
    const seen: Array<string | undefined> = []
    const a = new Hono()
    registerMcpRoute(
      a,
      {
        mcpToolSpecs: () => [],
        callMcpTool: async (name, _args, threadId) => {
          seen.push(threadId)
          return `ran ${name} as ${threadId ?? '(none)'}`
        },
      },
      TOKEN,
      { resolveThread: (tok) => (tok === 'tok-1' ? 'concierge_abc' : undefined) },
    )
    const call = (headers: Record<string, string>) =>
      a.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-podium-mcp-token': TOKEN,
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 't', arguments: {} },
        }),
      })
    return { seen, call }
  }

  it('resolves a known thread token and passes the threadId to callMcpTool', async () => {
    const { seen, call } = threadApp()
    const body = await json(await call({ 'x-podium-mcp-thread': 'tok-1' }))
    expect(body.result?.content?.[0]?.text).toBe('ran t as concierge_abc')
    expect(seen).toEqual(['concierge_abc'])
  })

  it('treats an unknown thread token as thread-blind (undefined threadId)', async () => {
    const { seen, call } = threadApp()
    await call({ 'x-podium-mcp-thread': 'forged' })
    expect(seen).toEqual([undefined])
  })

  it('treats an absent thread header as thread-blind', async () => {
    const { seen, call } = threadApp()
    await call({})
    expect(seen).toEqual([undefined])
  })
})
