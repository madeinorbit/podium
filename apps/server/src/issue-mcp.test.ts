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

  it('exposes the bulk-read twins issue_show (ids optional) and issue_tree [#82]', async () => {
    const p = new IssueToolProvider()
    const specs = p.mcpToolSpecs()
    const show = specs.find((s) => s.name === 'issue_show')!
    const schema = show.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['id', 'ids'])
    expect(schema.required).toEqual([]) // both optional; run() enforces ≥1 ref
    expect(specs.some((s) => s.name === 'issue_tree')).toBe(true)
  })

  it('issue_tree renders the subtree text via the set client [#82]', async () => {
    const p = new IssueToolProvider()
    p.setClient({
      issues: {
        tree: {
          query: vi.fn(async () => ({
            root: {
              seq: 5, title: 'Epic', stage: 'backlog', priority: 2, needsHuman: false,
              blocksDeps: [], description: '', closed: false, blocked: false, ready: true,
              children: [], omittedChildren: 0,
            },
            totalNodes: 1,
            omitted: 0,
          })),
        },
      },
    } as unknown as IssueTrpc)
    const out = await p.callMcpTool('issue_tree', { id: 5 })
    expect(out).toBe('#5 P2 [backlog] Epic — READY')
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
