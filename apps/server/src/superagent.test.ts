import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import {
  buildBtwDelta,
  buildBtwRecap,
  buildBtwSeed,
  harnessAllowedTools,
  matchAnswerToOptions,
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

describe('matchAnswerToOptions', () => {
  const labels = ['Yes, deploy', 'No, wait', 'Rollback']
  it('takes bare 1-based numbers, incl. comma-separated multi-select', () => {
    expect(matchAnswerToOptions('2', labels)).toEqual([2])
    expect(matchAnswerToOptions('1, 3', labels)).toEqual([1, 3])
  })
  it('rejects out-of-range numbers', () => {
    expect(matchAnswerToOptions('4', labels)).toEqual([])
  })
  it('matches an exact label case-insensitively', () => {
    expect(matchAnswerToOptions('no, wait', labels)).toEqual([2])
  })
  it('matches a UNIQUE substring, and refuses an ambiguous one', () => {
    expect(matchAnswerToOptions('rollback', labels)).toEqual([3])
    expect(matchAnswerToOptions(',', labels)).toEqual([]) // in every label
  })
})

// Session-steering belt (issue #62) — a real in-memory registry driven through
// callMcpTool, with a daemon fake that records inputs and answers transcript reads.
describe('session-steering tool belt (issue #62)', () => {
  const st = (phase: string, idle?: { kind: string }) =>
    ({ phase, since: 't', openTaskCount: 0, ...(idle ? { idle } : {}) }) as never

  function harness(opts?: { waitPollMs?: number; transcriptItems?: TranscriptItem[] }) {
    const registry = new SessionRegistry()
    const inputs: string[] = []
    registry.attachDaemon('local', (m) => {
      if (m.type === 'input') inputs.push(Buffer.from(m.data, 'base64').toString())
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
      if (m.type === 'transcriptRead') {
        queueMicrotask(() =>
          registry.onDaemonMessageFrom('local', {
            type: 'transcriptReadResult',
            requestId: m.requestId,
            sessionId: m.sessionId,
            items: opts?.transcriptItems ?? [],
            hasMore: false,
          }),
        )
      }
    })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const sa = new SuperagentService(registry, repos, registry.sessionStore, {
      waitPollMs: opts?.waitPollMs ?? 5,
    })
    const spawn = (live = false): string => {
      const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
      if (live)
        registry.onDaemonMessageFrom('local', {
          type: 'bind',
          sessionId,
          cmd: 'claude',
          cwd: '/w',
          agentKind: 'claude-code',
          geometry: { cols: 80, rows: 24 },
        })
      return sessionId
    }
    const metaOf = (id: string) => registry.listSessions().find((s) => s.sessionId === id)
    return { registry, sa, inputs, spawn, metaOf }
  }

  const askItem = (multiSelect = false): TranscriptItem =>
    item({
      id: 'q1',
      role: 'tool',
      toolName: 'AskUserQuestion',
      toolInputJson: JSON.stringify({
        questions: [
          {
            question: 'Deploy now?',
            multiSelect,
            options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }],
          },
        ],
      }),
    })

  it('answer_question matches a label and types the option digit into the menu', async () => {
    const h = harness({ transcriptItems: [askItem()] })
    const sessionId = h.spawn(true)
    const out = await h.sa.callMcpTool('answer_question', { sessionId, answer: 'No' })
    expect(JSON.parse(out)).toEqual({ answered: true, choices: [{ optionIndices: [2] }] })
    expect(h.inputs).toContain('2')
  })

  it('answer_question passes multi-select numbers through as a comma set + Enter', async () => {
    const h = harness({ transcriptItems: [askItem(true)] })
    const sessionId = h.spawn(true)
    const out = await h.sa.callMcpTool('answer_question', { sessionId, answer: '1,3' })
    expect(JSON.parse(out)).toEqual({ answered: true, choices: [{ optionIndices: [1, 3] }] })
    expect(h.inputs).toContain('1,3\r')
  })

  it('answer_question reports unmatched answers with the option list, and missing prompts', async () => {
    const h = harness({ transcriptItems: [askItem()] })
    const sessionId = h.spawn(true)
    expect(await h.sa.callMcpTool('answer_question', { sessionId, answer: 'maybe' })).toMatch(
      /could not match "maybe".*1\) Yes, 2\) No, 3\) Later/,
    )
    const empty = harness()
    const s2 = empty.spawn(true)
    expect(await empty.sa.callMcpTool('answer_question', { sessionId: s2, answer: 'Yes' })).toMatch(
      /no pending AskUserQuestion/,
    )
  })

  it('answer_question rejects an unknown session', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('answer_question', { sessionId: 'nope', answer: '1' })).toBe(
      'unknown session',
    )
  })

  it('resume_and_send accepts a message for a not-yet-live session (durable queue)', async () => {
    const h = harness()
    const sessionId = h.spawn() // starting: goes through the queue
    const out = await h.sa.callMcpTool('resume_and_send', { sessionId, text: 'carry on' })
    expect(out).toMatch(/^sent/)
    expect(h.metaOf(sessionId)?.queuedMessageCount).toBe(1)
  })

  it('resume_and_send fails on an unknown session', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('resume_and_send', { sessionId: 'nope', text: 'x' })).toBe(
      'failed: unknown session',
    )
  })

  it("continue_session types 'continue' into an errored live session only", async () => {
    const h = harness()
    const sessionId = h.spawn(true)
    h.registry.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: st('errored') })
    expect(await h.sa.callMcpTool('continue_session', { sessionId })).toBe('sent continue')
    expect(h.inputs).toContain('continue\r')
    // Not errored anymore → refused, with the gate surfaced.
    h.registry.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: st('idle') })
    expect(await h.sa.callMcpTool('continue_session', { sessionId })).toMatch(/errored phase/)
  })

  it('continue_session rejects an unknown session', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('continue_session', { sessionId: 'nope' })).toBe(
      'unknown session',
    )
  })

  it('hibernate_session parks a live session with a resume ref', async () => {
    const h = harness()
    const sessionId = h.spawn(true)
    h.registry.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'r1' },
    })
    expect(await h.sa.callMcpTool('hibernate_session', { sessionId })).toBe('hibernated')
    expect(h.metaOf(sessionId)?.status).toBe('hibernated')
  })

  it('hibernate_session surfaces the registry refusal reasons', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('hibernate_session', { sessionId: 'nope' })).toBe(
      'failed: unknown session',
    )
    const sessionId = h.spawn(true) // live but no resume ref yet
    expect(await h.sa.callMcpTool('hibernate_session', { sessionId })).toMatch(
      /failed: no resume ref/,
    )
  })

  it("snooze_session supports 'next-message' (null) and ISO timestamps; clear_snooze undoes", async () => {
    const h = harness()
    const sessionId = h.spawn()
    expect(
      await h.sa.callMcpTool('snooze_session', { sessionId, until: 'next-message' }),
    ).toBe(JSON.stringify({ snoozedUntil: null }))
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeNull()
    const iso = '2026-07-03T05:00:00.000Z'
    await h.sa.callMcpTool('snooze_session', { sessionId, until: iso })
    expect(h.metaOf(sessionId)?.snoozedUntil).toBe(iso)
    expect(await h.sa.callMcpTool('clear_snooze', { sessionId })).toBe('snooze cleared')
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeUndefined()
  })

  it('snooze_session rejects garbage untils and unknown sessions', async () => {
    const h = harness()
    const sessionId = h.spawn()
    expect(await h.sa.callMcpTool('snooze_session', { sessionId, until: 'whenever' })).toMatch(
      /invalid until/,
    )
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeUndefined()
    expect(
      await h.sa.callMcpTool('snooze_session', { sessionId: 'nope', until: 'next-message' }),
    ).toBe('unknown session')
    expect(await h.sa.callMcpTool('clear_snooze', { sessionId: 'nope' })).toBe('unknown session')
  })

  it('rename_session sets the user-facing name', async () => {
    const h = harness()
    const sessionId = h.spawn()
    expect(await h.sa.callMcpTool('rename_session', { sessionId, name: 'auth fix' })).toBe(
      'renamed',
    )
    expect(h.metaOf(sessionId)?.name).toBe('auth fix')
    expect(await h.sa.callMcpTool('rename_session', { sessionId: 'nope', name: 'x' })).toBe(
      'unknown session',
    )
  })

  it('set_work_state validates against the protocol WorkState enum', async () => {
    const h = harness()
    const sessionId = h.spawn()
    expect(await h.sa.callMcpTool('set_work_state', { sessionId, workState: 'testing' })).toBe(
      JSON.stringify({ workState: 'testing' }),
    )
    expect(h.metaOf(sessionId)?.workState).toBe('testing')
    expect(await h.sa.callMcpTool('set_work_state', { sessionId, workState: 'shipping' })).toMatch(
      /invalid workState/,
    )
    expect(h.metaOf(sessionId)?.workState).toBe('testing') // unchanged
    expect(
      await h.sa.callMcpTool('set_work_state', { sessionId: 'nope', workState: 'done' }),
    ).toBe('unknown session')
  })

  it('wait_for_session resolves early on the next phase event, with the verdict', async () => {
    const h = harness({ waitPollMs: 5 })
    const sessionId = h.spawn(true)
    // Seed a phase so the NEXT one is a real transition (prev==null logs nothing).
    h.registry.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: st('working') })
    const p = h.sa.callMcpTool('wait_for_session', { sessionId, timeoutSeconds: 10 })
    await new Promise((r) => setTimeout(r, 15))
    h.registry.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: st('idle', { kind: 'done' }),
    })
    expect(JSON.parse(await p)).toEqual({ phase: 'idle', verdict: 'done' })
  })

  it('wait_for_session times out quietly with the last-known phase (never throws)', async () => {
    const h = harness({ waitPollMs: 5 })
    const sessionId = h.spawn(true)
    h.registry.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: st('working') })
    expect(await h.sa.callMcpTool('wait_for_session', { sessionId, timeoutSeconds: 0 })).toBe(
      'timeout after 0s (session still working)',
    )
  })

  it('wait_for_session rejects an unknown session', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('wait_for_session', { sessionId: 'nope' })).toBe(
      'unknown session',
    )
  })

  it('list_sessions rows carry spawnedBy + snoozedUntil', async () => {
    const h = harness()
    const { sessionId } = h.registry.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      spawnedBy: 'user',
    })
    h.registry.setSnooze({ sessionId, until: null })
    const rows = JSON.parse(await h.sa.callMcpTool('list_sessions', {}, 'btw_x')) as Array<
      Record<string, unknown>
    >
    expect(rows[0]).toMatchObject({ sessionId, spawnedBy: 'user', snoozedUntil: null })
  })
})
