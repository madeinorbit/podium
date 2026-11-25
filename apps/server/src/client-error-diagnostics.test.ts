/**
 * Production errors carry no stack and no cause chain (POD-7615).
 *
 * The wire is checked through tRPC's own `getErrorShape` with the router's real
 * config (`t._config`), because that is where tRPC adds `data.stack`; a shape
 * built by hand never shows it. Production is reached the way the packaged
 * binary reaches it: `PODIUM_APP_VERSION` set when `trpc.ts` loads.
 */

import { TRPCError } from '@trpc/server'
import { getErrorShape } from '@trpc/server/unstable-core-do-not-import'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientErrorDiagnostics } from './client-error-diagnostics'
import { registerMcpRoute } from './mcp-route'

/** A store failure as it reaches a procedure: Drizzle's wrapper over the driver. */
function storeFailure(): TRPCError {
  const driver = new Error('connect ECONNREFUSED 10.0.0.9:5432')
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Failed query: insert into "locks"',
    cause: new Error('Failed query: insert into "locks"', { cause: driver }),
  })
}

async function wireShapeWhenLoadedWith(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const { t } = await import('./trpc')
  return getErrorShape({
    config: t._config,
    error: storeFailure(),
    type: 'query',
    path: 'issues.list',
    input: undefined,
    ctx: undefined,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the tRPC error shape on the wire', () => {
  it('carries no stack and no cause chain from a packaged server', async () => {
    const shape = await wireShapeWhenLoadedWith({ PODIUM_APP_VERSION: '1.2.3' })

    expect(shape.data).not.toHaveProperty('stack')
    expect(shape.data).not.toHaveProperty('causeChain')
    expect(JSON.stringify(shape)).not.toMatch(/ECONNREFUSED|\.ts:\d|node_modules|\/src\//)
    // What the client renders and branches on is unchanged.
    expect(shape.message).toBe('Failed query: insert into "locks"')
    expect(shape.data.code).toBe('INTERNAL_SERVER_ERROR')
    expect(shape.data.httpStatus).toBe(500)
    expect(shape.data.path).toBe('issues.list')
  })

  it('carries none either when NODE_ENV says production', async () => {
    const shape = await wireShapeWhenLoadedWith({ NODE_ENV: 'production' })

    expect(shape.data).not.toHaveProperty('stack')
    expect(shape.data).not.toHaveProperty('causeChain')
  })

  it('still carries both from a server run from source', async () => {
    const shape = await wireShapeWhenLoadedWith({})

    expect(shape.data.stack).toEqual(expect.stringContaining('client-error-diagnostics.test.ts'))
    expect(shape.data).toHaveProperty(
      'causeChain',
      'Failed query: insert into "locks" ← connect ECONNREFUSED 10.0.0.9:5432',
    )
  })
})

describe('when a server counts as production', () => {
  it.each([
    { packagedVersion: '1.2.3', nodeEnv: undefined, diagnostics: false },
    { packagedVersion: '0.9.0-dev.34', nodeEnv: undefined, diagnostics: false },
    { packagedVersion: '1.2.3', nodeEnv: 'development', diagnostics: false },
    { packagedVersion: undefined, nodeEnv: 'production', diagnostics: false },
    { packagedVersion: undefined, nodeEnv: undefined, diagnostics: true },
    { packagedVersion: undefined, nodeEnv: 'test', diagnostics: true },
  ])('packaged $packagedVersion, NODE_ENV $nodeEnv → diagnostics $diagnostics', (facts) => {
    expect(clientErrorDiagnostics(facts)).toBe(facts.diagnostics)
  })
})

describe('a failed MCP tool call', () => {
  async function toolErrorText(diagnostics: boolean): Promise<string | undefined> {
    const app = new Hono()
    registerMcpRoute(
      app,
      {
        mcpToolSpecs: () => [],
        callMcpTool: async () => {
          throw new Error('could not start the session', {
            cause: new Error('Failed query: select * from "sessions"'),
          })
        },
      },
      'token',
      { diagnostics },
    )
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-podium-mcp-token': 'token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }),
    })
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } }
    return body.result?.content?.[0]?.text
  }

  it('tells a production agent the error, not what lies under it', async () => {
    expect(await toolErrorText(false)).toBe('error: could not start the session')
  })

  it('keeps the chain in development', async () => {
    expect(await toolErrorText(true)).toBe(
      'error: could not start the session ← Failed query: select * from "sessions"',
    )
  })
})
