import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './issue-client'
import { CompositeMcpProvider, IssueToolProvider } from './issue-mcp'
import type { McpToolProvider } from './mcp-route'

describe('IssueToolProvider', () => {
  const client = {
    issues: { ready: { query: vi.fn(async () => [{ seq: 1, title: 'A' }]) } },
  } as unknown as IssueTrpc

  it('exposes one tool per command, namespaced issue_*, with an object inputSchema', () => {
    const p = new IssueToolProvider()
    const specs = p.mcpToolSpecs()
    const ready = specs.find((s) => s.name === 'issue_ready')
    expect(ready).toBeTruthy()
    expect((ready!.inputSchema as { type: string }).type).toBe('object')
    expect(specs.some((s) => s.name === 'issue_create')).toBe(true)
  })

  it('callMcpTool runs the command against the set client', async () => {
    const p = new IssueToolProvider()
    p.setClient(client)
    const out = await p.callMcpTool('issue_ready', { repoPath: '/r' })
    expect(out).toContain('A')
  })

  it('throws a clear error when no client is set', async () => {
    const p = new IssueToolProvider()
    await expect(p.callMcpTool('issue_ready', {})).rejects.toThrow(/not ready|no client/i)
  })
})

describe('CompositeMcpProvider', () => {
  const a: McpToolProvider = {
    mcpToolSpecs: () => [{ name: 'a_one', description: 'd', inputSchema: {} }],
    callMcpTool: async () => 'from-a',
  }
  const b: McpToolProvider = {
    mcpToolSpecs: () => [{ name: 'b_two', description: 'd', inputSchema: {} }],
    callMcpTool: async () => 'from-b',
  }
  it('merges specs and routes calls to the owning provider', async () => {
    const c = new CompositeMcpProvider([a, b])
    expect(
      c
        .mcpToolSpecs()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['a_one', 'b_two'])
    expect(await c.callMcpTool('b_two', {})).toBe('from-b')
  })
  it('throws on an unknown tool name', async () => {
    const c = new CompositeMcpProvider([a])
    await expect(c.callMcpTool('nope', {})).rejects.toThrow(/unknown/i)
  })
})
