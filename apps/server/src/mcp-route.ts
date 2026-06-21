import type { Hono } from 'hono'

/**
 * A provider of MCP tools — implemented by SuperagentService so a harness agent
 * (Claude with `--mcp-config`) can reach Podium's orchestrator tools.
 */
export interface McpToolProvider {
  mcpToolSpecs(): Array<{ name: string; description: string; inputSchema: unknown }>
  callMcpTool(name: string, args: Record<string, unknown>): Promise<string>
}

const PROTOCOL_VERSION = '2024-11-05'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

/**
 * Minimal MCP server over HTTP (JSON-RPC POST) exposing Podium's orchestrator
 * tools to a harness agent. Stateless and tools-only: `initialize`, `tools/list`,
 * `tools/call`, with `notifications/*` acknowledged. Gated by a bearer token (the
 * loopback HTTP surface is same-trust, but the token stops stray local processes).
 */
export function registerMcpRoute(app: Hono, provider: McpToolProvider, token: string): void {
  const tokenOf = (header: string | undefined): string | undefined =>
    header?.replace(/^Bearer\s+/i, '')

  app.post('/mcp', async (c) => {
    const supplied = c.req.header('x-podium-mcp-token') ?? tokenOf(c.req.header('authorization'))
    if (!token || supplied !== token) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } },
        401,
      )
    }

    let body: JsonRpcRequest
    try {
      body = (await c.req.json()) as JsonRpcRequest
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
        400,
      )
    }

    const id = body.id ?? null
    const method = body.method ?? ''

    if (method === 'initialize') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'podium', version: '1.0.0' },
        },
      })
    }
    if (method.startsWith('notifications/')) {
      // Notifications carry no id and expect no response body.
      return c.body(null, 202)
    }
    if (method === 'tools/list') {
      return c.json({ jsonrpc: '2.0', id, result: { tools: provider.mcpToolSpecs() } })
    }
    if (method === 'tools/call') {
      const name = body.params?.name
      if (!name) {
        return c.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'missing tool name' } })
      }
      try {
        const text = await provider.callMcpTool(name, body.params?.arguments ?? {})
        return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      } catch (err) {
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          },
        })
      }
    }
    return c.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    })
  })
}
