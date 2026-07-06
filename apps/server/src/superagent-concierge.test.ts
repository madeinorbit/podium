import { normalizeSettings } from '@podium/core'
import type { ControlMessage, IssueWire } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR } from './issue-authz'
import { IssueToolProvider } from './issue-mcp'
import type { LlmClient, LlmResponse } from './llm'
import { registerMcpRoute } from './mcp-route'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { callerAsIssueTrpc } from './server'
import {
  buildConciergeDelta,
  buildConciergeSeed,
  conciergeRepoPath,
  conciergeSystemPrompt,
  conciergeThreadId,
  NOT_CONFIRMED_MSG,
  SUPERAGENT_HARNESS_TIMEOUT_MS,
  SuperagentService,
} from './superagent'

// Scripted fake LLM: each concierge/send turn shifts responses off this queue.
// llmClient is mocked module-wide; everything else in ./llm stays real.
const llmScript: LlmResponse[] = []
vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>()
  return {
    ...actual,
    llmClient: (): LlmClient => ({
      label: 'fake · test',
      complete: async () => llmScript.shift() ?? { text: 'ok', toolCalls: [] },
    }),
  }
})

const registries: SessionRegistry[] = []
afterEach(() => {
  llmScript.length = 0
  for (const r of registries.splice(0)) r.dispose()
})

async function harness(opts?: { eventReadLimit?: number }) {
  const registry = new SessionRegistry()
  registries.push(registry)
  // Every harnessExecRequest the fake daemon saw (issue #84 routing assertions).
  const harnessCalls: Array<Extract<ControlMessage, { type: 'harnessExecRequest' }>> = []
  registry.attachDaemon('local', (m) => {
    if (m.type === 'repoOpRequest') {
      queueMicrotask(() =>
        registry.onDaemonMessageFrom('local', {
          type: 'repoOpResult',
          requestId: m.requestId,
          ok: true,
          output: '',
        }),
      )
    }
    if (m.type === 'harnessExecRequest') {
      harnessCalls.push(m)
      queueMicrotask(() =>
        registry.onDaemonMessageFrom('local', {
          type: 'harnessExecResult',
          requestId: m.requestId,
          ok: true,
          output: 'harness says hi',
        }),
      )
    }
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r') // concierge() rejects unregistered repos
  const sa = new SuperagentService(registry, repos, registry.sessionStore, opts)
  // Same wiring as server.ts: issue tools over an in-process OPERATOR caller.
  const issueTools = new IssueToolProvider()
  const caller = appRouter.createCaller({ registry, repos, superagent: sa, capability: OPERATOR })
  issueTools.setClient(callerAsIssueTrpc(caller))
  sa.setIssueTools(issueTools)
  return { registry, repos, sa, harnessCalls }
}

const wire = (o: Partial<IssueWire>): IssueWire =>
  ({
    id: 'iss_x',
    repoPath: '/r',
    seq: 1,
    title: 'T',
    priority: 2,
    blockedBy: [],
    needsHuman: false,
    ...o,
  }) as IssueWire

describe('conciergeThreadId', () => {
  it('is deterministic and reversible', () => {
    const id = conciergeThreadId('/home/u/src/repo')
    expect(id).toBe(conciergeThreadId('/home/u/src/repo'))
    expect(id.startsWith('concierge_')).toBe(true)
    expect(conciergeRepoPath(id)).toBe('/home/u/src/repo')
  })
  it('returns undefined for non-concierge ids', () => {
    expect(conciergeRepoPath('btw_s1')).toBeUndefined()
  })
})

describe('buildConciergeSeed', () => {
  const seed = buildConciergeSeed({
    repoPath: '/r',
    ready: [wire({ id: 'a', seq: 3, title: 'Fix login', priority: 1 })],
    blocked: [wire({ id: 'b', seq: 4, title: 'Ship it', blockedBy: ['a'] })],
    needsHuman: [wire({ id: 'c', seq: 5, humanQuestion: 'Which region?' })],
    all: [
      wire({ id: 'a', seq: 3, title: 'Fix login' }),
      wire({ id: 'b', seq: 4 }),
      wire({ id: 'c', seq: 5 }),
    ],
    sessions: [
      {
        sessionId: 's1',
        name: 'worker',
        agentKind: 'claude-code',
        phase: 'working',
        spawnedBy: 'issue:a',
        issueSeq: 3,
      },
    ],
    events: [
      { ts: 't1', kind: 'issue.created', subject: 'a', payload: { seq: 3, title: 'Fix login' } },
    ],
    maxEventId: 7,
  })
  it('lists ready issues as #seq title P?', () => {
    expect(seed).toContain('#3 Fix login P1')
  })
  it('names what blocks each blocked issue', () => {
    expect(seed).toContain('#4 Ship it P2 — blocked by #3')
  })
  it('carries the needs-human question', () => {
    expect(seed).toContain('#5 Which region?')
  })
  it('lists live sessions with kind/phase/provenance/bound issue', () => {
    expect(seed).toContain('worker · claude-code · working · by issue:a · issue #3')
  })
  it('renders issue events as one-liners and marks the repo + cursor', () => {
    expect(seed).toContain('[CONCIERGE CONTEXT]')
    expect(seed).toContain('Repo: /r')
    expect(seed).toContain('#3 created "Fix login"')
    expect(seed).toContain('event cursor 7')
  })
  it('stays compact', () => {
    expect(seed.length).toBeLessThan(8000)
  })
})

describe('buildConciergeDelta', () => {
  it('marks the previous/new cursors and lists events', () => {
    const msg = buildConciergeDelta({
      prevEventId: 2,
      events: [
        { ts: 't2', kind: 'issue.closed', subject: 'a', payload: { seq: 3, reason: 'done' } },
      ],
      maxEventId: 9,
      now: '2026-07-03T00:00:00Z',
    })
    expect(msg).toContain('[CONCIERGE UPDATE @ 2026-07-03T00:00:00Z]')
    expect(msg).toContain('event 2')
    expect(msg).toContain('#3 closed (done)')
    expect(msg).toContain('caught up to event 9')
  })
})

describe('concierge threads (issue #64)', () => {
  it('reuses one thread per repo across calls — never duplicates', async () => {
    const { sa } = await harness()
    const a = await sa.concierge({ repoPath: '/r', text: 'hello' })
    const b = await sa.concierge({ repoPath: '/r', text: 'again' })
    expect(a.threadId).toBe(b.threadId)
    expect(a.isNew).toBe(true)
    expect(b.isNew).toBe(false)
    const threads = sa.listThreads().filter((t) => t.kind === 'concierge')
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ id: conciergeThreadId('/r'), repoPath: '/r' })
  })

  it('seeds a new thread with ready/needs-human/session lines from the tracker', async () => {
    const { registry, sa } = await harness()
    const ready = registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    const asking = registry.issues.create({ repoPath: '/r', title: 'Deploy', startNow: false })
    registry.issues.setNeedsHuman(asking.id, 'Which region?')
    registry.createSession({ agentKind: 'claude-code', cwd: '/r', spawnedBy: 'user' })
    const { threadId } = await sa.concierge({ repoPath: '/r', text: 'status?' })
    const seedMsg = sa.history(threadId)[0]
    expect(seedMsg?.role).toBe('user')
    expect(seedMsg?.content).toContain('[CONCIERGE CONTEXT]')
    expect(seedMsg?.content).toContain(`#${ready.seq} Fix login`)
    expect(seedMsg?.content).toContain('Which region?')
    expect(seedMsg?.content).toContain('claude-code')
  })

  it('prepends an issue-event delta on re-open after a watermark gap', async () => {
    const { registry, sa } = await harness()
    const { threadId } = await sa.concierge({ repoPath: '/r', text: 'hi' })
    registry.issues.create({ repoPath: '/r', title: 'New work', startNow: false })
    await sa.concierge({ repoPath: '/r', text: 'what changed?' })
    const contents = sa.history(threadId).map((m) => m.content)
    expect(contents.some((c) => c.includes('[CONCIERGE UPDATE'))).toBe(true)
    expect(contents.some((c) => c.includes('created "New work"'))).toBe(true)
    // No gap → no second delta.
    await sa.concierge({ repoPath: '/r', text: 'and now?' })
    const updates = sa.history(threadId).filter((m) => m.content.includes('[CONCIERGE UPDATE'))
    expect(updates).toHaveLength(1)
  })

  it('runs issue tools through the api loop (mock LLM calls issue_search)', async () => {
    const { registry, sa } = await harness()
    registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    llmScript.push(
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'issue_search', arguments: JSON.stringify({ text: 'login' }) },
        ],
      },
      { text: 'Found #1 Fix login.', toolCalls: [] },
    )
    const turn = await sa.concierge({ repoPath: '/r', text: 'anything about login?' })
    const toolMsg = turn.messages.find((m) => m.role === 'tool' && m.toolName === 'issue_search')
    expect(toolMsg?.content).toContain('#1')
    expect(toolMsg?.content).toContain('Fix login')
    expect(turn.messages[turn.messages.length - 1]?.content).toBe('Found #1 Fix login.')
  })

  it('gates start-capable tools behind confirmed:true on concierge threads', async () => {
    const { registry, sa } = await harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    const tid = conciergeThreadId('/r')
    // Unconfirmed → refused, nothing spawned, issue untouched.
    expect(await sa.callMcpTool('issue_start', { id: issue.id }, tid)).toBe(NOT_CONFIRMED_MSG)
    expect(await sa.callMcpTool('start_agent', { agentKind: 'claude-code', cwd: '/r' }, tid)).toBe(
      NOT_CONFIRMED_MSG,
    )
    expect(registry.listSessions()).toHaveLength(0)
    expect(registry.issues.get(issue.id)?.stage).toBe('backlog')
    // Confirmed → runs (confirmed stripped before the underlying tool).
    const out = JSON.parse(
      await sa.callMcpTool(
        'start_agent',
        { agentKind: 'claude-code', cwd: '/r', confirmed: true },
        tid,
      ),
    ) as { sessionId: string }
    expect(out.sessionId).toBeDefined()
  })

  it('does not gate start tools on non-concierge threads', async () => {
    const { registry, sa } = await harness()
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', { agentKind: 'shell', cwd: '/w' }, 'btw_s1'),
    ) as { sessionId: string }
    expect(registry.listSessions().find((s) => s.sessionId === out.sessionId)).toBeDefined()
  })

  it('rejects an unregistered repoPath without minting a thread', async () => {
    const { sa } = await harness()
    await expect(sa.concierge({ repoPath: '/typo', text: 'hi' })).rejects.toThrow(/unknown repo/)
    expect(sa.listThreads().filter((t) => t.kind === 'concierge')).toHaveLength(0)
  })

  it('two concurrent first opens seed exactly once (reads inside the lock)', async () => {
    const { sa } = await harness()
    const [a, b] = await Promise.all([
      sa.concierge({ repoPath: '/r', text: 'first' }),
      sa.concierge({ repoPath: '/r', text: 'second' }),
    ])
    expect([a.isNew, b.isNew].filter(Boolean)).toHaveLength(1)
    const seeds = sa.history(a.threadId).filter((m) => m.content.includes('[CONCIERGE CONTEXT]'))
    expect(seeds).toHaveLength(1)
  })

  it('gates issue_create --start behind confirmed, refusing BEFORE any mutation', async () => {
    const { registry, sa } = await harness()
    const tid = conciergeThreadId('/r')
    // Unconfirmed create --start → refused whole: no issue, no session.
    expect(
      await sa.callMcpTool('issue_create', { repoPath: '/r', title: 'Big', start: true }, tid),
    ).toBe(NOT_CONFIRMED_MSG)
    expect(registry.issues.list('/r')).toHaveLength(0)
    expect(registry.listSessions()).toHaveLength(0)
    // Plain create (no start) stays ungated — filing issues is always allowed.
    const plain = await sa.callMcpTool('issue_create', { repoPath: '/r', title: 'Note' }, tid)
    expect(plain).toContain('created #1 Note')
    // Confirmed create --start → created AND started.
    const out = await sa.callMcpTool(
      'issue_create',
      { repoPath: '/r', title: 'Big', start: true, confirmed: true },
      tid,
    )
    expect(out).toContain('created #2 Big')
    expect(out).toContain('started in')
    expect(registry.issues.list('/r').find((i) => i.title === 'Big')?.stage).toBe('in_progress')
  })

  // Issue #67: the harness backend reaches these tools over the HTTP MCP route,
  // whose per-thread token now resolves the concierge identity server-side —
  // the confirmed-gate and superagent:<threadId> provenance work end-to-end.
  describe('through the HTTP MCP route (issue #67)', () => {
    const ROUTE_TOKEN = 'route-secret'
    async function httpHarness() {
      const h = await harness()
      const app = new Hono()
      // Same wiring shape as server.ts: calls dispatch through the superagent,
      // thread tokens resolve via the service's token map.
      registerMcpRoute(
        app,
        {
          mcpToolSpecs: (threadId) => h.sa.mcpToolSpecs(threadId),
          callMcpTool: (name, args, threadId) => h.sa.callMcpTool(name, args, threadId),
        },
        ROUTE_TOKEN,
        { resolveThread: (tok) => h.sa.threadForMcpToken(tok) },
      )
      const call = async (name: string, args: Record<string, unknown>, threadToken?: string) => {
        const res = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-podium-mcp-token': ROUTE_TOKEN,
            ...(threadToken ? { 'x-podium-mcp-thread': threadToken } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } }
        return body.result?.content?.[0]?.text ?? ''
      }
      const list = async (threadToken?: string) => {
        const res = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-podium-mcp-token': ROUTE_TOKEN,
            ...(threadToken ? { 'x-podium-mcp-thread': threadToken } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        const body = (await res.json()) as {
          result?: { tools?: Array<{ name: string; inputSchema: unknown }> }
        }
        return body.result?.tools ?? []
      }
      return { ...h, call, list }
    }

    // The advertised schema must carry the gate's `confirmed` param: schema-strict
    // harness clients strip args absent from tools/list, so a hidden param makes
    // the confirmed-gate unsatisfiable from a concierge thread.
    it('advertises `confirmed` on start-capable issue tools in tools/list', async () => {
      const { sa, list } = await httpHarness()
      const tok = sa.mcpThreadToken(conciergeThreadId('/r'))
      const props = (name: string, tools: Awaited<ReturnType<typeof list>>) =>
        Object.keys(
          ((tools.find((t) => t.name === name)?.inputSchema ?? {}) as {
            properties?: Record<string, unknown>
          }).properties ?? {},
        )
      const concierge = await list(tok)
      expect(props('issue_start', concierge)).toContain('confirmed')
      expect(props('start_agent', concierge)).toContain('confirmed')
      expect(props('issue_create', concierge)).toContain('confirmed')
      // Identity-less lists fail closed the same way the call path does.
      const blind = await list()
      expect(props('issue_start', blind)).toContain('confirmed')
      // Non-concierge threads stay ungated — no confirmed param advertised.
      const global = await list(sa.mcpThreadToken('btw_s1'))
      expect(props('issue_start', global)).not.toContain('confirmed')
    })

    it('attaches the confirmed-gate for a concierge thread token', async () => {
      const { registry, sa, call } = await httpHarness()
      const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
      const tok = sa.mcpThreadToken(conciergeThreadId('/r'))
      // Start-capable tools without confirmed → refused over HTTP, nothing spawned.
      expect(await call('issue_start', { id: issue.id }, tok)).toBe(NOT_CONFIRMED_MSG)
      expect(await call('start_agent', { agentKind: 'claude-code', cwd: '/r' }, tok)).toBe(
        NOT_CONFIRMED_MSG,
      )
      expect(registry.listSessions()).toHaveLength(0)
      expect(registry.issues.get(issue.id)?.stage).toBe('backlog')
    })

    it('stamps superagent:<threadId> provenance on a resolved thread', async () => {
      const { registry, sa, call } = await httpHarness()
      const tid = conciergeThreadId('/r')
      const tok = sa.mcpThreadToken(tid)
      const out = JSON.parse(
        await call('start_agent', { agentKind: 'shell', cwd: '/r', confirmed: true }, tok),
      ) as { sessionId: string }
      expect(registry.listSessions().find((s) => s.sessionId === out.sessionId)?.spawnedBy).toBe(
        `superagent:${tid}`,
      )
    })

    it('fails closed on start-capable tools for identity-less callers only', async () => {
      const { registry, call } = await httpHarness()
      // No thread token (or a forged one) → the confirmed-gate applies anyway.
      expect(await call('start_agent', { agentKind: 'shell', cwd: '/r' })).toBe(NOT_CONFIRMED_MSG)
      expect(await call('start_agent', { agentKind: 'shell', cwd: '/r' }, 'forged')).toBe(
        NOT_CONFIRMED_MSG,
      )
      expect(registry.listSessions()).toHaveLength(0)
      // Non-spawning tools stay ungated for identity-less callers.
      expect(JSON.parse(await call('list_sessions', {}))).toEqual([])
    })
  })

  it('advances the watermark only to the last read event on delta overflow', async () => {
    const { registry, sa } = await harness({ eventReadLimit: 2 })
    const { threadId } = await sa.concierge({ repoPath: '/r', text: 'hi' })
    // 3 issue.created events > limit 2: first re-open digests 2, second the rest.
    registry.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    registry.issues.create({ repoPath: '/r', title: 'B', startNow: false })
    registry.issues.create({ repoPath: '/r', title: 'C', startNow: false })
    await sa.concierge({ repoPath: '/r', text: 'update?' })
    const afterFirst = sa.history(threadId).filter((m) => m.content.includes('[CONCIERGE UPDATE'))
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.content).toContain('created "A"')
    expect(afterFirst[0]?.content).toContain('created "B"')
    expect(afterFirst[0]?.content).not.toContain('created "C"')
    // The overflowed remainder arrives on the next open — nothing silently lost.
    await sa.concierge({ repoPath: '/r', text: 'more?' })
    const updates = sa.history(threadId).filter((m) => m.content.includes('[CONCIERGE UPDATE'))
    expect(updates).toHaveLength(2)
    expect(updates[1]?.content).toContain('created "C"')
  })
})

// Recall (issue #72): ground new work in prior work — omni-search in the belt,
// session→issue back-links, and a prior-art step in the intake protocol.
describe('search_all tool', () => {
  it('wraps the real searchAll: renders one line per typed hit plus the data payload', async () => {
    const { registry, sa } = await harness()
    registry.attachDaemon('m1', () => {})
    const issue = registry.issues.create({
      repoPath: '/r',
      title: 'replace the flux capacitor',
      description: 'it drifts',
      startNow: false,
    })
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.renameSession({ sessionId, name: 'capacitor refactor' })
    registry.sessionStore.upsertConversations([
      {
        id: 'native-conv',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        title: 'capacitor deep dive',
        updatedAt: '2026-07-01T09:00:00.000Z',
        machineId: 'm1',
      },
    ])
    const out = await sa.callMcpTool('search_all', { query: 'capacitor' })
    // One rendered line per hit: [kind] title (ref) — issues cite the display seq.
    expect(out).toContain(`[issue] replace the flux capacitor`)
    expect(out).toContain(`(#${issue.seq})`)
    expect(out).toContain('[session] capacitor refactor')
    expect(out).toContain('[conversation] capacitor deep dive')
    // Plus the machine-readable payload (SearchResultWire rows).
    const json = out.slice(out.indexOf('\n\n[') + 2)
    const rows = JSON.parse(json) as { kind: string; id: string }[]
    expect(rows.map((r) => r.kind).sort()).toEqual(['conversation', 'issue', 'session'])
  })

  it('filters by kinds and caps the limit', async () => {
    const { registry, sa } = await harness()
    registry.issues.create({ repoPath: '/r', title: 'capacitor issue', startNow: false })
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.renameSession({ sessionId, name: 'capacitor session' })
    const out = await sa.callMcpTool('search_all', { query: 'capacitor', kinds: ['issue'] })
    expect(out).toContain('[issue]')
    expect(out).not.toContain('[session]')
    expect(await sa.callMcpTool('search_all', { query: 'zzz-no-such-thing' })).toBe('(no results)')
    expect(await sa.callMcpTool('search_all', {})).toBe('missing query')
  })
})

describe('list_sessions boundIssue', () => {
  it('carries {seq, title} for sessions inside an issue worktree, absent otherwise', async () => {
    const { registry, sa } = await harness()
    // issue_create --start mints the worktree; read state back from the tracker.
    await sa.callMcpTool(
      'issue_create',
      { repoPath: '/r', title: 'Worktree work', start: true, confirmed: true },
      conciergeThreadId('/r'),
    )
    const issue = registry.issues.list('/r').find((i) => i.title === 'Worktree work')
    expect(issue?.worktreePath).toBeTruthy()
    // A second session inside the issue worktree, one outside.
    registry.createSession({ agentKind: 'shell', cwd: issue?.worktreePath ?? '/x' })
    registry.createSession({ agentKind: 'shell', cwd: '/elsewhere' })
    const rows = JSON.parse(await sa.callMcpTool('list_sessions', {})) as {
      cwd: string
      boundIssue?: { seq: number; title: string }
    }[]
    const inside = rows.filter((r) => r.cwd === issue?.worktreePath)
    expect(inside.length).toBeGreaterThan(0)
    for (const r of inside) {
      expect(r.boundIssue).toEqual({ seq: issue?.seq, title: 'Worktree work' })
    }
    const outside = rows.find((r) => r.cwd === '/elsewhere')
    expect(outside).toBeDefined()
    expect(outside).not.toHaveProperty('boundIssue')
  })
})

describe('concierge prior-art intake', () => {
  it('the concierge prompt instructs a prior-art check before filing new work', () => {
    const p = conciergeSystemPrompt('/r')
    expect(p).toContain('PRIOR ART')
    expect(p).toContain('search_all')
    expect(p).toContain('issue_find_duplicates')
    expect(p).toContain('worktreePath')
    expect(p).toContain('continue the existing thread of work or start fresh')
    // The interactive-only + confirmed rules stay untouched.
    expect(p).toContain('INTERACTIVE-ONLY')
    expect(p).toContain('{"confirmed": true}')
    // Status answers cite their sources.
    expect(p).toContain('Cite the sessions and issue #s')
  })
})

// Issue #84: every turn routes through the settings-chosen FULL harness when it
// can mount Podium's MCP tools; anything else runs the api loop with a visible
// one-line notice — never silently.
describe('harness-always backend resolution (issue #84)', () => {
  const ROUTE_SECRET = 'route-secret-84'
  it('default settings route to the claude-code harness with MCP + long timeout', async () => {
    const { sa, harnessCalls } = await harness()
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'route-tok', ['list_sessions', 'issue_list'])
    const turn = await sa.send('global', 'hello')
    expect(harnessCalls).toHaveLength(1)
    const call = harnessCalls[0]!
    expect(call.agent).toBe('claude-code')
    expect(call.timeoutMs).toBe(SUPERAGENT_HARNESS_TIMEOUT_MS)
    expect(call.allowedTools).toContain('mcp__podium__issue_list')
    // The mcp-config carries the per-thread identity token (issue #67) — it
    // resolves back to the sending thread server-side.
    const cfg = JSON.parse(call.mcpConfig ?? '{}') as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>
    }
    const podium = cfg.mcpServers.podium!
    expect(podium.url).toBe('http://127.0.0.1:1878/mcp')
    expect(podium.headers['x-podium-mcp-token']).toBe('route-tok')
    expect(sa.threadForMcpToken(podium.headers['x-podium-mcp-thread'] ?? '')).toBe('global')
    // The harness reply lands on the thread, labeled as a harness turn.
    expect(turn.backendLabel).toBe('claude-code harness')
    expect(turn.messages.at(-1)?.content).toBe('harness says hi')
  })

  it('an explicit codex harness choice routes to the codex CLI', async () => {
    const { registry, sa, harnessCalls } = await harness()
    registry.sessionStore.setSettings(
      normalizeSettings({ superagent: { kind: 'harness', harnessAgent: 'codex' } }),
    )
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'route-tok')
    const turn = await sa.send('global', 'hello')
    expect(harnessCalls[0]?.agent).toBe('codex')
    expect(turn.backendLabel).toBe('codex harness')
  })

  it('a no-MCP harness (grok) falls back to the api loop with one visible notice', async () => {
    const { registry, sa, harnessCalls } = await harness()
    registry.sessionStore.setSettings(normalizeSettings({ sessionDefaults: { agent: 'grok' } }))
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'route-tok')
    llmScript.push({ text: 'api reply', toolCalls: [] }, { text: 'api reply 2', toolCalls: [] })
    const first = await sa.send('global', 'hello')
    expect(harnessCalls).toHaveLength(0)
    const notice = first.messages.find((m) =>
      m.content.includes('running on the api fallback: grok cannot mount Podium tools'),
    )
    expect(notice).toBeDefined()
    expect(first.messages.at(-1)?.content).toBe('api reply')
    // The notice is not repeated on the next turn.
    const second = await sa.send('global', 'again')
    expect(second.messages.some((m) => m.content.includes('api fallback'))).toBe(false)
  })

  it('without an MCP endpoint even claude falls back, with a notice naming why', async () => {
    const { sa, harnessCalls } = await harness()
    llmScript.push({ text: 'ok', toolCalls: [] })
    const turn = await sa.send('global', 'hello')
    expect(harnessCalls).toHaveLength(0)
    expect(
      turn.messages.some((m) => m.content.includes('Podium MCP endpoint is not available')),
    ).toBe(true)
  })

  it('a concierge harness turn keeps thread identity + the confirmed gate (#67, e2e)', async () => {
    const { registry, sa, harnessCalls } = await harness()
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', ROUTE_SECRET)
    const app = new Hono()
    registerMcpRoute(
      app,
      {
        mcpToolSpecs: () => [],
        callMcpTool: (name, args, threadId) => sa.callMcpTool(name, args, threadId),
      },
      ROUTE_SECRET,
      { resolveThread: (tok) => sa.threadForMcpToken(tok) },
    )
    const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    await sa.concierge({ repoPath: '/r', text: 'what should we do?' })
    // The concierge turn ran on the harness, carrying its own thread token…
    expect(harnessCalls.length).toBeGreaterThan(0)
    const cfg = JSON.parse(harnessCalls.at(-1)?.mcpConfig ?? '{}') as {
      mcpServers: Record<string, { headers: Record<string, string> }>
    }
    const threadTok = cfg.mcpServers.podium?.headers['x-podium-mcp-thread'] ?? ''
    expect(sa.threadForMcpToken(threadTok)).toBe(conciergeThreadId('/r'))
    // …and a tool call through the HTTP MCP route under that token hits the
    // concierge confirmed-gate: start-capable tools refuse without confirmed.
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-podium-mcp-token': ROUTE_SECRET,
        'x-podium-mcp-thread': threadTok,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'issue_start', arguments: { id: issue.id } },
      }),
    })
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } }
    expect(body.result?.content?.[0]?.text).toBe(NOT_CONFIRMED_MSG)
    expect(registry.issues.get(issue.id)?.stage).toBe('backlog')
  })
})

// Review of #84: notices are PERSISTED once per thread ever — marker messages in
// the thread survive a service restart (this box redeploys constantly).
describe('persisted one-time thread notices (issue #84 review)', () => {
  it('a harness turn over saved api-kind settings posts the flip notice once ever', async () => {
    const { registry, repos, sa, harnessCalls } = await harness()
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'tok')
    const first = await sa.send('global', 'hello')
    const flip = first.messages.filter((m) => m.content.startsWith('superagent now runs the full'))
    expect(flip).toHaveLength(1)
    expect(flip[0]?.content).toContain('claude-code harness (was: api/openrouter)')
    expect(flip[0]?.content).toContain('change in Settings if unwanted')
    // Not repeated on the next turn…
    const second = await sa.send('global', 'again')
    expect(second.messages.some((m) => m.content.includes('now runs the full'))).toBe(false)
    // …and not after a service restart over the same store (persisted flag).
    const sa2 = new SuperagentService(registry, repos, registry.sessionStore)
    sa2.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'tok')
    const third = await sa2.send('global', 'once more')
    expect(third.messages.some((m) => m.content.includes('now runs the full'))).toBe(false)
    expect(harnessCalls).toHaveLength(3)
  })

  it('an explicit harness choice posts no flip notice', async () => {
    const { registry, sa } = await harness()
    registry.sessionStore.setSettings(
      normalizeSettings({ superagent: { kind: 'harness', harnessAgent: 'claude-code' } }),
    )
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'tok')
    const turn = await sa.send('global', 'hello')
    expect(turn.messages.some((m) => m.content.includes('now runs the full'))).toBe(false)
  })

  it('the api-fallback notice survives a service restart without re-posting', async () => {
    const { registry, repos, sa } = await harness()
    registry.sessionStore.setSettings(normalizeSettings({ sessionDefaults: { agent: 'grok' } }))
    sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'tok')
    llmScript.push({ text: 'a', toolCalls: [] }, { text: 'b', toolCalls: [] })
    const first = await sa.send('global', 'hello')
    expect(first.messages.some((m) => m.content.startsWith('running on the api fallback'))).toBe(
      true,
    )
    const sa2 = new SuperagentService(registry, repos, registry.sessionStore)
    sa2.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'tok')
    const second = await sa2.send('global', 'again')
    expect(second.messages.some((m) => m.content.includes('api fallback'))).toBe(false)
  })
})
