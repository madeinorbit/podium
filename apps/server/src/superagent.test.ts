import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import {
  buildBtwDelta,
  buildBtwRecap,
  buildBtwSeed,
  harnessAllowedTools,
  SuperagentService,
  transcriptDelta,
} from './superagent'

const item = (o: Partial<TranscriptItem>): TranscriptItem => ({
  id: 'i',
  role: 'user',
  text: '',
  ...o,
})

describe('transcriptDelta', () => {
  const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
  it('returns items after the watermark id', () => {
    expect(transcriptDelta(items, { itemId: 'a' }).map((i) => i.id)).toEqual(['b', 'c'])
  })
  it('returns all when the watermark id is missing (transcript rolled)', () => {
    expect(transcriptDelta(items, { itemId: 'zzz' }).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('returns all when there is no watermark yet', () => {
    expect(transcriptDelta(items, {}).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('returns empty when caught up', () => {
    expect(transcriptDelta(items, { itemId: 'c' })).toEqual([])
  })
})

describe('buildBtwRecap', () => {
  const items: TranscriptItem[] = [
    item({ id: 'u1', role: 'user', text: 'go' }),
    item({ id: 't1', role: 'tool', toolName: 'Bash', toolInput: 'ls' }),
    item({ id: 't2', role: 'tool', toolName: 'Edit', toolInput: 'path=src/app.ts' }),
    item({ id: 't3', role: 'tool', toolName: 'Edit', toolInput: 'lib/util.ts' }),
    item({ id: 'a1', role: 'assistant', text: 'done' }),
  ]
  it('counts turns and tool calls', () => {
    expect(buildBtwRecap(items)).toContain('Recap: 1 user / 1 assistant turns, 3 tool calls')
  })
  it('renders a tool histogram, busiest first', () => {
    expect(buildBtwRecap(items)).toContain('Tools: Edit×2, Bash×1')
  })
  it('lists files touched by file-editing tools, newest first', () => {
    const recap = buildBtwRecap(items)
    expect(recap).toContain('Files: lib/util.ts, src/app.ts')
  })
  it('omits tool/file lines when there is no tool activity', () => {
    const recap = buildBtwRecap([item({ id: 'u', role: 'user', text: 'hi' })])
    expect(recap).toBe('Recap: 1 user / 0 assistant turns, 0 tool calls')
  })
})

describe('buildBtwSeed', () => {
  const items: TranscriptItem[] = [
    item({ id: 'u1', role: 'user', text: 'do thing', ts: '2026-06-16T07:00:00Z' }),
    item({ id: 't1', role: 'tool', toolName: 'Bash', toolResult: 'x'.repeat(5000) }),
    item({ id: 'a1', role: 'assistant', text: 'done', ts: '2026-06-16T07:01:00Z' }),
    item({ id: 'u2', role: 'user', text: 'next thing', ts: '2026-06-16T07:02:00Z' }),
  ]
  const seed = buildBtwSeed({
    session: { sessionId: 's1', name: 'feat-x', agentKind: 'claude-code', cwd: '/repo' },
    summary: 'Working on X.',
    items,
    maxChars: 20_000,
  })
  it('marks the section, session, summary, and caught-up watermark', () => {
    expect(seed).toContain('[BTW CONTEXT]')
    expect(seed).toContain('s1')
    expect(seed).toContain('Working on X.')
    expect(seed).toContain('u2') // last item id = caught-up marker
    expect(seed).toContain('Recap:') // deterministic recap embedded
  })
  it('includes every user message verbatim', () => {
    expect(seed).toContain('do thing')
    expect(seed).toContain('next thing')
  })
  it('truncates long tool results and stays within budget', () => {
    expect(seed.length).toBeLessThanOrEqual(20_000)
    expect(seed).not.toContain('x'.repeat(1000))
  })
  it('omits the summary line when none is given', () => {
    expect(buildBtwSeed({ session: { sessionId: 's1' }, items })).not.toContain('Summary:')
  })
})

describe('buildBtwDelta', () => {
  it('marks the previous and new watermarks and lists new items', () => {
    const delta = [item({ id: 'n1', role: 'user', text: 'more', ts: '2026-06-16T09:00:00Z' })]
    const msg = buildBtwDelta({
      prev: { itemId: 'u2', ts: '2026-06-16T07:02:00Z' },
      delta,
      now: '2026-06-16T09:01:00Z',
    })
    expect(msg).toContain('[BTW UPDATE @ 2026-06-16T09:01:00Z]')
    expect(msg).toContain('u2') // previous watermark
    expect(msg).toContain('more')
    expect(msg).toContain('n1') // new watermark
  })
})

describe('harnessAllowedTools', () => {
  const own = ['superagent_search']
  it('allow-lists the full composite tool set (superagent + issue) when known', () => {
    const allowed = harnessAllowedTools(['superagent_search', 'issue_create', 'issue_list'], own)
    expect(allowed).toContain('mcp__podium__issue_create')
    expect(allowed).toContain('mcp__podium__issue_list')
    expect(allowed).toContain('mcp__podium__superagent_search')
    // The read-only builtins are always present alongside the MCP tools.
    expect(allowed).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']))
  })
  it('falls back to the superagent own tools when the full set is unknown', () => {
    const allowed = harnessAllowedTools(undefined, own)
    expect(allowed).toContain('mcp__podium__superagent_search')
    expect(allowed).not.toContain('mcp__podium__issue_create')
  })
})

// Tool-arg wiring for start_agent (issue #60) — a real in-memory registry, driven
// through callMcpTool (the same tools() the API loop uses). The daemon fake
// auto-answers git ops so issues.start can complete.
describe('start_agent tool wiring (issue #60)', () => {
  function harness() {
    const registry = new SessionRegistry()
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
    return { registry, sa }
  }

  it("passes title through and tags spawnedBy 'superagent' when no thread is known (MCP path)", async () => {
    const { registry, sa } = harness()
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', {
        agentKind: 'claude-code',
        cwd: '/w',
        title: 'Investigate flake',
      }),
    ) as { sessionId: string; cwd: string; agentKind: string }
    expect(out).toMatchObject({ cwd: '/w', agentKind: 'claude-code' })
    const meta = registry.listSessions().find((s) => s.sessionId === out.sessionId)
    expect(meta?.title).toBe('Investigate flake')
    expect(meta?.spawnedBy).toBe('superagent')
  })

  it('tags spawnedBy with the executing thread when known', async () => {
    const { registry, sa } = harness()
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', { agentKind: 'shell', cwd: '/w' }, 'btw_s1'),
    ) as { sessionId: string }
    expect(registry.listSessions().find((s) => s.sessionId === out.sessionId)?.spawnedBy).toBe(
      'superagent:btw_s1',
    )
  })

  it("issueId on a started issue spawns in the issue's worktree", async () => {
    const { registry, sa } = harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    registry.issues.update(issue.id, { worktreePath: '/r/.worktrees/issue-1-x', stage: 'planning' })
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', {
        agentKind: 'claude-code',
        cwd: '/ignored',
        issueId: issue.id,
      }),
    ) as { sessionId: string; cwd: string }
    expect(out.cwd).toBe('/r/.worktrees/issue-1-x')
    const meta = registry.listSessions().find((s) => s.sessionId === out.sessionId)
    expect(meta?.cwd).toBe('/r/.worktrees/issue-1-x')
    expect(meta?.spawnedBy).toBe('superagent')
  })

  it('issueId on an unstarted issue starts the issue instead and reports its session', async () => {
    const { registry, sa } = harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', {
        agentKind: 'claude-code',
        cwd: '/ignored',
        issueId: issue.id,
      }),
    ) as { sessionId?: string; cwd: string }
    expect(out.cwd).toBe('/r/.worktrees/issue-1-fix-login')
    expect(out.sessionId).toBeDefined()
    const meta = registry.listSessions().find((s) => s.sessionId === out.sessionId)
    // The spawn is owned by issues.start, so provenance is the issue's, not the superagent's.
    expect(meta?.spawnedBy).toBe(`issue:${issue.id}`)
    expect(registry.issues.get(issue.id)?.stage).toBe('in_progress')
  })

  it('works with issueId alone — cwd is optional when the issue provides it', async () => {
    const { registry, sa } = harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    registry.issues.update(issue.id, { worktreePath: '/r/.worktrees/issue-1-x', stage: 'planning' })
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', { agentKind: 'claude-code', issueId: issue.id }),
    ) as { sessionId: string; cwd: string }
    expect(out.cwd).toBe('/r/.worktrees/issue-1-x')
    expect(registry.listSessions().find((s) => s.sessionId === out.sessionId)?.cwd).toBe(
      '/r/.worktrees/issue-1-x',
    )
  })

  it('rejects a call with neither cwd nor issueId, spawning nothing', async () => {
    const { registry, sa } = harness()
    const out = await sa.callMcpTool('start_agent', { agentKind: 'claude-code' })
    expect(out).toMatch(/pass cwd or issueId/)
    expect(registry.listSessions()).toHaveLength(0)
  })

  it('rejects an unknown issue ref without spawning anything', async () => {
    const { registry, sa } = harness()
    const out = await sa.callMcpTool('start_agent', {
      agentKind: 'claude-code',
      cwd: '/w',
      issueId: 'iss_nope',
    })
    expect(out).toMatch(/unknown issue/)
    expect(registry.listSessions()).toHaveLength(0)
  })
})
