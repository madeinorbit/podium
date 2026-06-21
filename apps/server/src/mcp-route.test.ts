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
