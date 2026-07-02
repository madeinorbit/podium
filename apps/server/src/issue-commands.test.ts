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
      setNeedsHuman: proc('setNeedsHuman'),
      clearNeedsHuman: proc('clearNeedsHuman'),
      start: proc('start'),
      archive: proc('archive'),
      action: proc('action'),
      addSession: proc('addSession'),
      addShell: proc('addShell'),
      events: proc('events'),
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

  it('includes the full verb set (P4b parity + lifecycle verbs)', () => {
    const names = ISSUE_COMMANDS.map((c) => c.name)
    for (const v of ['delete', 'label', 'defer', 'undefer', 'supersede', 'duplicate', 'dep-remove', 'reparent', 'find-duplicates', 'graph', 'doctor', 'stale', 'orphans', 'lint', 'preflight', 'count', 'epic-status', 'start', 'archive', 'action', 'add-session', 'add-shell']) {
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
    expect(out.text).toContain('7')
    expect(out.text).toContain('Fix login')
    expect(out.data).toMatchObject({ seq: 7 })
  })

  it('ready calls issues.ready.query and lists titles', async () => {
    const { client } = mockClient({
      ready: [
        { seq: 1, title: 'A', priority: 0 },
        { seq: 2, title: 'B', priority: 2 },
      ],
    })
    const out = await cmd('ready').run(client, { repoPath: '/r' })
    expect(out.text).toContain('A')
    expect(out.text).toContain('B')
    expect(out.data).toHaveLength(2)
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

  it('needs-human calls issues.setNeedsHuman.mutate with id + question', async () => {
    const { client, calls } = mockClient()
    await cmd('needs-human').run(client, { id: 'iss_1', question: 'which key?' })
    expect(calls).toContainEqual({
      path: 'setNeedsHuman',
      kind: 'mutate',
      input: { id: 'iss_1', question: 'which key?' },
    })
  })

  it('clear-needs-human calls issues.clearNeedsHuman.mutate with id', async () => {
    const { client, calls } = mockClient()
    await cmd('clear-needs-human').run(client, { id: 'iss_1' })
    expect(calls).toContainEqual({
      path: 'clearNeedsHuman',
      kind: 'mutate',
      input: { id: 'iss_1' },
    })
  })

  it('prime command returns the server prime text', async () => {
    const fake = {
      issues: { prime: { query: async () => 'PRIME OUTPUT' } },
      repos: { inferFromPath: { query: async () => ({ repoPath: '/r' }) } },
    } as unknown as import('./issue-client').IssueTrpc
    const cmd = ISSUE_COMMANDS.find((c) => c.name === 'prime')!
    expect(cmd).toBeTruthy()
    expect((await cmd.run(fake, { repoPath: '/r' })).text).toBe('PRIME OUTPUT')
  })

  it('id args accept display refs and numbers (schema coercion)', () => {
    const show = cmd('show')
    expect(show.args.parse({ id: 10 })).toEqual({ id: '10' })
    expect(show.args.parse({ id: '#10' })).toEqual({ id: '#10' })
    expect(show.args.parse({ id: 'iss_abc' })).toEqual({ id: 'iss_abc' })
  })

  it('comment defaults the author to agent', () => {
    const parsed = cmd('comment').args.parse({ id: '10', body: 'hi' }) as { author: string }
    expect(parsed.author).toBe('agent')
  })

  it('close --note records a completion-note comment before closing', async () => {
    const { client, calls } = mockClient({ close: { seq: 5 } })
    const out = await cmd('close').run(client, {
      id: '5',
      note: 'done: shipped the fix',
      author: 'agent',
    })
    const idx = (p: string) => calls.findIndex((c) => c.path === p)
    expect(idx('addComment')).toBeGreaterThanOrEqual(0)
    expect(idx('close')).toBeGreaterThan(idx('addComment'))
    expect(calls[idx('addComment')].input.body).toContain('[completion-note]')
    expect(out.text).toContain('completion note')
  })

  it('start maps to issues.start.mutate', async () => {
    const { client, calls } = mockClient({
      start: { seq: 3, branch: 'issue/3-x', worktreePath: '/r/.worktrees/issue-3-x' },
    })
    const out = await cmd('start').run(client, { id: '3' })
    expect(calls).toContainEqual({ path: 'start', kind: 'mutate', input: { id: '3' } })
    expect(out.text).toContain('issue/3-x')
  })

  it('show throws on a missing issue (non-zero exit, not a 0-exit string)', async () => {
    const fake = {
      issues: { get: { query: async () => null } },
    } as unknown as IssueTrpc
    await expect(cmd('show').run(fake, { id: '99' })).rejects.toThrow(/unknown issue 99/)
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

  it('events queries issues.events with the cursor, comma-split kinds, and renders one line per event', async () => {
    const rows = [
      { id: 3, ts: 't1', kind: 'issue.closed', subject: 'iss_a', payload: { seq: 1, reason: 'done' } },
      { id: 4, ts: 't2', kind: 'issue.ready', subject: 'iss_b', payload: { seq: 2, unblockedBy: 1 } },
    ]
    const { client, calls } = mockClient({ events: rows })
    const out = await cmd('events').run(client, { since: 2, kind: 'issue.closed,issue.ready', limit: 10 })
    expect(calls).toContainEqual({
      path: 'events',
      kind: 'query',
      input: { since: 2, kinds: ['issue.closed', 'issue.ready'], limit: 10 },
    })
    expect(out.text.split('\n')).toEqual([
      '[3] t1 issue.closed iss_a {"seq":1,"reason":"done"}',
      '[4] t2 issue.ready iss_b {"seq":2,"unblockedBy":1}',
    ])
    expect(out.data).toEqual(rows)
  })

  it('events renders (no events) when the log is empty past the cursor', async () => {
    const { client } = mockClient({ events: [] })
    const out = await cmd('events').run(client, { since: 0 })
    expect(out.text).toBe('(no events)')
    expect(out.data).toEqual([])
  })
})
