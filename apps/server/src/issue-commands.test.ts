import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './issue-client'
import { ISSUE_COMMANDS } from './issue-commands'

// Minimal mock of the tRPC client surface the commands use.
function mockClient(overrides: Record<string, unknown> = {}): { client: IssueTrpc; calls: any[] } {
  const calls: any[] = []
  const proc = (path: string) => ({
    query: vi.fn(async (input: unknown) => {
      calls.push({ path, kind: 'query', input })
      return (overrides[path] as unknown) ?? []
    }),
    mutate: vi.fn(async (input: unknown) => {
      calls.push({ path, kind: 'mutate', input })
      return (overrides[path] as unknown) ?? { id: 'iss_1', seq: 1, title: 't' }
    }),
  })
  const client = {
    issues: {
      ready: proc('ready'),
      list: proc('list'),
      get: proc('get'),
      create: proc('create'),
      update: proc('update'),
      close: proc('close'),
      claim: proc('claim'),
      depAdd: proc('depAdd'),
      addComment: proc('addComment'),
      search: proc('search'),
      stats: proc('stats'),
    },
  } as unknown as IssueTrpc
  return { client, calls }
}

function cmd(name: string) {
  const c = ISSUE_COMMANDS.find((x) => x.name === name)
  if (!c) throw new Error(`no command ${name}`)
  return c
}

describe('ISSUE_COMMANDS registry', () => {
  it('every command has a unique name, a summary, and a zod args schema', () => {
    const names = ISSUE_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of ISSUE_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0)
      expect(typeof c.args.parse).toBe('function')
    }
  })

  it('includes the full verb set (P4b parity)', () => {
    const names = ISSUE_COMMANDS.map((c) => c.name)
    for (const v of ['delete', 'label', 'defer', 'undefer', 'supersede', 'duplicate', 'dep-remove', 'reparent', 'find-duplicates', 'graph', 'doctor', 'stale', 'orphans', 'lint', 'preflight', 'count', 'epic-status']) {
      expect(names, `missing verb ${v}`).toContain(v)
    }
  })

  it('create calls issues.create.mutate with the title and returns the new id/seq', async () => {
    const { client, calls } = mockClient({ create: { id: 'iss_9', seq: 7, title: 'Fix login' } })
    const out = await cmd('create').run(client, { repoPath: '/r', title: 'Fix login' })
    expect(calls).toContainEqual({
      path: 'create',
      kind: 'mutate',
      input: expect.objectContaining({ title: 'Fix login', repoPath: '/r', startNow: false }),
    })
    expect(out).toContain('7')
    expect(out).toContain('Fix login')
  })

  it('ready calls issues.ready.query and lists titles', async () => {
    const { client } = mockClient({
      ready: [
        { seq: 1, title: 'A', priority: 0 },
        { seq: 2, title: 'B', priority: 2 },
      ],
    })
    const out = await cmd('ready').run(client, { repoPath: '/r' })
    expect(out).toContain('A')
    expect(out).toContain('B')
  })

  it('claim calls issues.claim.mutate with id + assignee', async () => {
    const { client, calls } = mockClient()
    await cmd('claim').run(client, { id: 'iss_1', assignee: 'agent:claude' })
    expect(calls).toContainEqual({
      path: 'claim',
      kind: 'mutate',
      input: { id: 'iss_1', assignee: 'agent:claude' },
    })
  })

  it('prime command returns the server prime text', async () => {
    const fake = {
      issues: { prime: { query: async () => 'PRIME OUTPUT' } },
      repos: { inferFromPath: { query: async () => ({ repoPath: '/r' }) } },
    } as unknown as import('./issue-client').IssueTrpc
    const cmd = ISSUE_COMMANDS.find((c) => c.name === 'prime')!
    expect(cmd).toBeTruthy()
    expect(await cmd.run(fake, { repoPath: '/r' })).toBe('PRIME OUTPUT')
  })

  it('create passes --parentId through to the mutation', async () => {
    const calls: unknown[] = []
    const fake = {
      issues: { create: { mutate: async (i: unknown) => { calls.push(i); return { seq: 2, title: 'child' } } } },
      repos: { inferFromPath: { query: async () => ({ repoPath: '/r' }) } },
    } as unknown as import('./issue-client').IssueTrpc
    const cmd = ISSUE_COMMANDS.find((c) => c.name === 'create')!
    await cmd.run(fake, { repoPath: '/r', title: 'child', parentId: 'iss_parent' })
    expect(calls[0]).toMatchObject({ parentId: 'iss_parent', title: 'child' })
  })
})
