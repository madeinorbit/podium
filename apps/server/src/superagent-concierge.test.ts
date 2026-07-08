import type { ControlMessage, IssueWire } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { IssueToolProvider } from './issue-mcp'
import { registerMcpRoute } from './mcp-route'
import {
  buildConciergeDelta,
  buildConciergeSeed,
  conciergeRepoPath,
  conciergeSystemPrompt,
  conciergeThreadId,
  NOT_CONFIRMED_MSG,
  SuperagentService,
} from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { callerAsIssueTrpc } from './server'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

type TurnReq = Extract<ControlMessage, { type: 'headlessTurnRequest' }>

async function harness(opts?: { eventReadLimit?: number }) {
  const registry = new SessionRegistry()
  registries.push(registry)
  // Every headless turn the fake daemon saw. Turns auto-resolve ok so the
  // conciergeTurn flow completes without a real harness.
  const turnReqs: TurnReq[] = []
  registry.modules.sessions.attachDaemon('local', (m) => {
    if (m.type === 'repoOpRequest') {
      queueMicrotask(() =>
        registry.modules.sessions.onDaemonMessageFrom('local', {
          type: 'repoOpResult',
          requestId: m.requestId,
          ok: true,
          output: '',
        }),
      )
    }
    if (m.type === 'headlessTurnRequest') {
      turnReqs.push(m)
      queueMicrotask(() =>
        registry.modules.sessions.onDaemonMessageFrom('local', {
          type: 'headlessTurnResult',
          requestId: m.requestId,
          ok: true,
          harnessSessionId: `h-${turnReqs.length}`,
          output: 'harness says hi',
        }),
      )
    }
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r') // conciergeTurn rejects unregistered repos
  const sa = new SuperagentService(registry.modules, repos, registry.sessionStore, opts)
  // Same wiring as server.ts: issue tools over an in-process OPERATOR caller.
  const issueTools = new IssueToolProvider()
  const caller = appRouter.createCaller({ registry, repos, superagent: sa, capability: OPERATOR })
  issueTools.setClient(callerAsIssueTrpc(caller))
  sa.setIssueTools(issueTools)
  const settle = () => new Promise((r) => setTimeout(r))
  return { registry, repos, sa, turnReqs, settle }
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
  it('reuses one thread per repo across turns — never duplicates', async () => {
    const { sa, settle } = await harness()
    const a = await sa.conciergeTurn({ repoPath: '/r', text: 'hello' })
    await settle()
    const b = await sa.conciergeTurn({ repoPath: '/r', text: 'again' })
    expect(a.threadId).toBe(b.threadId)
    expect(a.isNew).toBe(true)
    expect(b.isNew).toBe(false)
    const threads = sa.listThreads().filter((t) => t.kind === 'concierge')
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ id: conciergeThreadId('/r'), repoPath: '/r' })
  })

  it('seeds a new thread with ready/needs-human/session lines from the tracker', async () => {
    const { registry, sa, turnReqs } = await harness()
    const ready = registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    const asking = registry.issues.create({ repoPath: '/r', title: 'Deploy', startNow: false })
    registry.issues.setNeedsHuman(asking.id, 'Which region?')
    registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/r', spawnedBy: 'user' })
    await sa.conciergeTurn({ repoPath: '/r', text: 'status?' })
    const prompt = turnReqs[0]?.prompt ?? ''
    expect(prompt).toContain('[CONCIERGE CONTEXT]')
    expect(prompt).toContain(`#${ready.seq} Fix login`)
    expect(prompt).toContain('Which region?')
    expect(prompt).toContain('claude-code')
    expect(prompt.endsWith('status?')).toBe(true)
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
    expect(registry.modules.sessions.listSessions()).toHaveLength(0)
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
    expect(registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)).toBeDefined()
  })

  it('rejects an unregistered repoPath without minting a thread', async () => {
    const { sa } = await harness()
    await expect(sa.conciergeTurn({ repoPath: '/typo', text: 'hi' })).rejects.toThrow(
      /unknown repo/,
    )
    expect(sa.listThreads().filter((t) => t.kind === 'concierge')).toHaveLength(0)
  })

  it('gates issue_create --start behind confirmed, refusing BEFORE any mutation', async () => {
    const { registry, sa } = await harness()
    const tid = conciergeThreadId('/r')
    // Unconfirmed create --start → refused whole: no issue, no session.
    expect(
      await sa.callMcpTool('issue_create', { repoPath: '/r', title: 'Big', start: true }, tid),
    ).toBe(NOT_CONFIRMED_MSG)
    expect(registry.issues.list('/r')).toHaveLength(0)
    expect(registry.modules.sessions.listSessions()).toHaveLength(0)
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
      expect(registry.modules.sessions.listSessions()).toHaveLength(0)
      expect(registry.issues.get(issue.id)?.stage).toBe('backlog')
    })

    it('stamps superagent:<threadId> provenance on a resolved thread', async () => {
      const { registry, sa, call } = await httpHarness()
      const tid = conciergeThreadId('/r')
      const tok = sa.mcpThreadToken(tid)
      const out = JSON.parse(
        await call('start_agent', { agentKind: 'shell', cwd: '/r', confirmed: true }, tok),
      ) as { sessionId: string }
      expect(registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)?.spawnedBy).toBe(
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
      expect(registry.modules.sessions.listSessions()).toHaveLength(0)
      // Non-spawning tools stay ungated for identity-less callers.
      expect(JSON.parse(await call('list_sessions', {}))).toEqual([])
    })
  })

  it('advances the watermark only to the last read event on delta overflow', async () => {
    const { registry, sa, turnReqs, settle } = await harness({ eventReadLimit: 2 })
    await sa.conciergeTurn({ repoPath: '/r', text: 'hi' })
    await settle()
    // 3 issue.created events > limit 2: first re-entry digests 2, second the rest.
    registry.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    registry.issues.create({ repoPath: '/r', title: 'B', startNow: false })
    registry.issues.create({ repoPath: '/r', title: 'C', startNow: false })
    await sa.conciergeTurn({ repoPath: '/r', text: 'update?' })
    await settle()
    const second = turnReqs[1]?.prompt ?? ''
    expect(second).toContain('[CONCIERGE UPDATE')
    expect(second).toContain('created "A"')
    expect(second).toContain('created "B"')
    expect(second).not.toContain('created "C"')
    // The overflowed remainder arrives on the next turn — nothing silently lost.
    await sa.conciergeTurn({ repoPath: '/r', text: 'more?' })
    await settle()
    const third = turnReqs[2]?.prompt ?? ''
    expect(third).toContain('[CONCIERGE UPDATE')
    expect(third).toContain('created "C"')
  })
})

// Recall (issue #72): ground new work in prior work — omni-search in the belt,
// session→issue back-links, and a prior-art step in the intake protocol.
describe('search_all tool', () => {
  it('wraps the real searchAll: renders one line per typed hit plus the data payload', async () => {
    const { registry, sa } = await harness()
    registry.modules.sessions.attachDaemon('m1', () => {})
    const issue = registry.issues.create({
      repoPath: '/r',
      title: 'replace the flux capacitor',
      description: 'it drifts',
      startNow: false,
    })
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.modules.sessions.renameSession({ sessionId, name: 'capacitor refactor' })
    registry.sessionStore.conversations.upsertConversations([
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
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.modules.sessions.renameSession({ sessionId, name: 'capacitor session' })
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
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: issue?.worktreePath ?? '/x' })
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/elsewhere' })
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
