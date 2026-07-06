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
      cleanup: proc('cleanup'),
      addSession: proc('addSession'),
      addShell: proc('addShell'),
      events: proc('events'),
      children: proc('children'),
      depReport: proc('depReport'),
      panelApply: proc('panelApply'),
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
    for (const v of ['delete', 'label', 'defer', 'undefer', 'supersede', 'duplicate', 'dep-remove', 'reparent', 'find-duplicates', 'graph', 'doctor', 'stale', 'orphans', 'lint', 'preflight', 'count', 'epic-status', 'start', 'archive', 'action', 'cleanup', 'add-session', 'add-shell']) {
      expect(names, `missing verb ${v}`).toContain(v)
    }
  })

  it('cleanup calls issues.cleanup.mutate with the id and reports OK/REFUSED', async () => {
    const { client, calls } = mockClient({
      cleanup: { ok: true, output: 'removed /r/.worktrees/issue-1-x; deleted branch issue/1-x' },
    })
    const out = await cmd('cleanup').run(client, { id: 'iss_1' })
    expect(calls).toContainEqual({ path: 'cleanup', kind: 'mutate', input: { id: 'iss_1' } })
    expect(out.text).toContain('cleanup: OK')
    expect(out.text).toContain('deleted branch issue/1-x')

    const refused = mockClient({ cleanup: { ok: false, output: 'refusing cleanup: issue #1 is still open (close it first)' } })
    const out2 = await cmd('cleanup').run(refused.client, { id: 'iss_1' })
    expect(out2.text).toContain('cleanup: REFUSED')
    expect(out2.text).toContain('still open')
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

  it('create maps --agent/--model/--effort to defaultAgent/defaultModel/defaultEffort', async () => {
    const { client, calls } = mockClient()
    await cmd('create').run(client, {
      repoPath: '/r',
      title: 'T',
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
    })
    expect(calls).toContainEqual({
      path: 'create',
      kind: 'mutate',
      input: expect.objectContaining({
        defaultAgent: 'codex',
        defaultModel: 'gpt-5.2-codex',
        defaultEffort: 'high',
      }),
    })
  })

  it('update maps --agent/--model/--effort into the patch', async () => {
    const { client, calls } = mockClient()
    await cmd('update').run(client, { id: '3', agent: 'claude-code', model: 'opus-4-5', effort: 'low' })
    expect(calls).toContainEqual({
      path: 'update',
      kind: 'mutate',
      input: {
        id: '3',
        patch: { defaultAgent: 'claude-code', defaultModel: 'opus-4-5', defaultEffort: 'low' },
      },
    })
  })

  it('start passes --agent through as agentKind (overrides the issue defaultAgent server-side)', async () => {
    const { client, calls } = mockClient({
      start: { seq: 3, branch: 'issue/3-x', worktreePath: '/r/.worktrees/issue-3-x' },
    })
    await cmd('start').run(client, { id: '3', agent: 'codex' })
    expect(calls).toContainEqual({
      path: 'start',
      kind: 'mutate',
      input: { id: '3', agentKind: 'codex' },
    })
  })

  it('show surfaces defaultAgent/defaultModel/defaultEffort in the meta line and data', async () => {
    const { client } = mockClient({
      get: {
        id: 'iss_1',
        seq: 1,
        title: 'T',
        description: 'd',
        stage: 'backlog',
        priority: 2,
        ready: true,
        blocked: false,
        defaultAgent: 'codex',
        defaultModel: 'gpt-5.2-codex',
        defaultEffort: 'high',
      },
    })
    const out = await cmd('show').run(client, { id: '1' })
    expect(out.text).toContain('agent=codex model=gpt-5.2-codex effort=high')
    expect(out.data).toMatchObject({
      defaultAgent: 'codex',
      defaultModel: 'gpt-5.2-codex',
      defaultEffort: 'high',
    })
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

describe('children + deps commands (epic ergonomics)', () => {
  it('children renders one line per subissue with a status mark', async () => {
    const { client, calls } = mockClient({
      children: [
        { seq: 2, title: 'a', stage: 'backlog', priority: 2, ready: true, blocked: false },
        { seq: 3, title: 'b', stage: 'backlog', priority: 2, ready: false, blocked: true },
        { seq: 4, title: 'c', stage: 'done', priority: 2, ready: false, blocked: false },
      ],
    })
    const out = await cmd('children').run(client, { id: '#1', recursive: true })
    expect(calls).toContainEqual({ path: 'children', kind: 'query', input: { id: '#1', recursive: true } })
    const lines = out.text.split('\n')
    expect(lines[0]).toContain('#2')
    expect(lines[0]).toContain('READY')
    expect(lines[1]).toContain('BLOCKED')
    expect(lines[2]).toContain('DONE')
  })

  it('children reports empty', async () => {
    const { client } = mockClient({ children: [] })
    const out = await cmd('children').run(client, { id: '1' })
    expect(out.text).toBe('(no subissues)')
  })

  it('deps renders waits-on/blocks edges with open/closed state', async () => {
    const { client, calls } = mockClient({
      depReport: [
        {
          seq: 1, title: 'E', stage: 'backlog', priority: 2, closed: false, blocked: false, ready: true,
          deps: [], dependents: [],
        },
        {
          seq: 2, title: 'b', stage: 'backlog', priority: 2, closed: false, blocked: true, ready: false,
          deps: [
            { seq: 3, title: 'a', type: 'blocks', closed: false },
            { seq: 4, title: 'd', type: 'related', closed: true },
          ],
          dependents: [{ seq: 5, title: 'e', type: 'blocks', closed: false }],
        },
      ],
    })
    const out = await cmd('deps').run(client, { id: '#1' })
    expect(calls).toContainEqual({ path: 'depReport', kind: 'query', input: { id: '#1' } })
    expect(out.text).toContain('#1 P2 [backlog] E — READY')
    expect(out.text).toContain('#2 P2 [backlog] b — BLOCKED')
    expect(out.text).toContain('waits on: #3 (open), #4 (closed, related)')
    expect(out.text).toContain('blocks: #5 (open)')
  })

  it('deps without id queries the repo set', async () => {
    const { client, calls } = mockClient({ depReport: [] })
    const out = await cmd('deps').run(client, { repoPath: '/r' })
    expect(calls).toContainEqual({ path: 'depReport', kind: 'query', input: { repoPath: '/r' } })
    expect(out.text).toBe('(no issues in set)')
  })
})

describe('panel commands (todo / artifact / deferred)', () => {
  it('todo --add mutates via panelApply and prints the checklist', async () => {
    const { client, calls } = mockClient({
      panelApply: { seq: 1, panel: { todos: [{ text: 'ship it', done: false }], artifacts: [], deferred: [] } },
    })
    const out = await cmd('todo').run(client, { id: '1', add: 'ship it' })
    expect(calls).toContainEqual({
      path: 'panelApply', kind: 'mutate', input: { id: '1', op: 'todo-add', text: 'ship it' },
    })
    expect(out.text).toBe('1. [ ] ship it')
  })

  it('todo --done n and no-flag print', async () => {
    const done = mockClient({
      panelApply: { seq: 1, panel: { todos: [{ text: 'a', done: true }], artifacts: [], deferred: [] } },
    })
    const out = await cmd('todo').run(done.client, { id: '1', done: 1 })
    expect(done.calls).toContainEqual({
      path: 'panelApply', kind: 'mutate', input: { id: '1', op: 'todo-done', index: 1 },
    })
    expect(out.text).toBe('1. [x] a')
    const show = mockClient({ get: { seq: 1, panel: undefined } })
    expect((await cmd('todo').run(show.client, { id: '1' })).text).toBe('(no human todos)')
    expect(show.calls.some((c: { path: string }) => c.path === 'panelApply')).toBe(false)
  })

  it('artifact --add passes path+title; deferred --add passes text', async () => {
    const art = mockClient({
      panelApply: { seq: 1, panel: { todos: [], artifacts: [{ path: 's.png', title: 'shot', addedAt: 't' }], deferred: [] } },
    })
    const out = await cmd('artifact').run(art.client, { id: '1', add: 's.png', title: 'shot' })
    expect(art.calls).toContainEqual({
      path: 'panelApply', kind: 'mutate',
      input: { id: '1', op: 'artifact-add', path: 's.png', title: 'shot' },
    })
    expect(out.text).toBe('1. shot — s.png')
    const def = mockClient({
      panelApply: { seq: 1, panel: { todos: [], artifacts: [], deferred: [{ text: 'later', addedAt: 't' }] } },
    })
    await cmd('deferred').run(def.client, { id: '1', add: 'later' })
    expect(def.calls).toContainEqual({
      path: 'panelApply', kind: 'mutate', input: { id: '1', op: 'deferred-add', text: 'later' },
    })
  })
})
