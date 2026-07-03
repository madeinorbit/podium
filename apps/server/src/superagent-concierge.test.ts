import type { IssueWire } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueToolProvider } from './issue-mcp'
import type { LlmClient, LlmResponse } from './llm'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { callerAsIssueTrpc } from './server'
import {
  buildConciergeDelta,
  buildConciergeSeed,
  conciergeRepoPath,
  conciergeThreadId,
  NOT_CONFIRMED_MSG,
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

function harness() {
  const registry = new SessionRegistry()
  registries.push(registry)
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
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const sa = new SuperagentService(registry, repos, registry.sessionStore)
  // Same wiring as server.ts: issue tools over an in-process OPERATOR caller.
  const issueTools = new IssueToolProvider()
  const caller = appRouter.createCaller({ registry, repos, superagent: sa, capability: OPERATOR })
  issueTools.setClient(callerAsIssueTrpc(caller))
  sa.setIssueTools(issueTools)
  return { registry, sa }
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
    const { sa } = harness()
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
    const { registry, sa } = harness()
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
    const { registry, sa } = harness()
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
    const { registry, sa } = harness()
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
    const { registry, sa } = harness()
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
    const { registry, sa } = harness()
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', { agentKind: 'shell', cwd: '/w' }, 'btw_s1'),
    ) as { sessionId: string }
    expect(registry.listSessions().find((s) => s.sessionId === out.sessionId)).toBeDefined()
  })
})
