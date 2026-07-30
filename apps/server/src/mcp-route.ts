import type { Hono } from 'hono'

/**
 * A provider of MCP tools — implemented by SuperagentService so a harness agent
 * (Claude with `--mcp-config`) can reach Podium's orchestrator tools.
 */
export interface McpToolProvider {
  /** `threadId` (when the transport resolved one) lets the provider shape specs
   *  per thread — e.g. advertise the `confirmed` gate param on start-capable
   *  tools for concierge/thread-blind callers, so harness clients that validate
   *  args against the advertised schema can actually pass the flag. */
  mcpToolSpecs(
    threadId?: string,
  ): Array<{ name: string; description: string; inputSchema: unknown }>
  /** `threadId` (when the transport resolved one) scopes the call to the
   *  superagent thread it runs for — gate + session provenance (issue #67). */
  callMcpTool(name: string, args: Record<string, unknown>, threadId?: string): Promise<string>
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
 *
 * Thread identity (issue #67): each harness invocation's mcp-config carries an
 * opaque per-thread token in `x-podium-mcp-thread`; `resolveThread` maps it back
 * to the threadId server-side. Opaque-token-in-header (not the raw threadId, not
 * the URL) so the id can't be forged by a caller and the URL — which leaks into
 * process lists and logs — stays identity-free. Absent/unknown token → the call
 * runs thread-blind (callMcpTool then fails closed on start-capable tools).
 */
export function registerMcpRoute(
  app: Hono,
  provider: McpToolProvider,
  token: string,
  opts?: { resolveThread?: (threadToken: string) => string | undefined },
): void {
  const tokenOf = (header: string | undefined): string | undefined =>
    header?.replace(/^Bearer\s+/i, '')

  // Streamable-HTTP transport handshake: a modern MCP client (codex 0.144.5's
  // rmcp) OPENS the connection with `GET /mcp` to look for a server-initiated
  // SSE stream, and may `DELETE /mcp` to end a session. Podium is POST-only
  // JSON-RPC (no server push, no client-driven session teardown), so the spec's
  // answer for both is 405 Method Not Allowed — which tells the client to fall
  // back to plain POST. Without this the GET falls through to a 404, and rmcp
  // mis-reads that as an OAuth challenge, probes `/.well-known/oauth-*`, finds
  // nothing, and the transport worker quits with `Auth(AuthorizationRequired)`,
  // killing the whole harness turn (POD-1021).
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.body(null, 405, { allow: 'POST' }))

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
      // Same thread resolution as tools/call: the advertised schemas must match
      // what the call path enforces (the concierge confirmed-gate adds a
      // `confirmed` param — if it's absent from the listed schema, schema-strict
      // harness clients strip it and the gate can never be satisfied).
      const listThreadToken = c.req.header('x-podium-mcp-thread')
      const listThreadId = listThreadToken ? opts?.resolveThread?.(listThreadToken) : undefined
      return c.json({ jsonrpc: '2.0', id, result: { tools: provider.mcpToolSpecs(listThreadId) } })
    }
    if (method === 'tools/call') {
      const name = body.params?.name
      if (!name) {
        return c.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'missing tool name' } })
      }
      const threadToken = c.req.header('x-podium-mcp-thread')
      const threadId = threadToken ? opts?.resolveThread?.(threadToken) : undefined
      try {
        const text = await provider.callMcpTool(name, body.params?.arguments ?? {}, threadId)
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
