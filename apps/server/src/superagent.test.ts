import { asSessionId, asThreadId, FIRST_ADMIN_USER_ID, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  buildBtwDelta,
  buildBtwRecap,
  buildBtwSeed,
  harnessAllowedTools,
  matchAnswerToOptions,
  NOT_CONFIRMED_MSG,
  SuperagentService,
  transcriptDelta,
} from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'

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
    session: {
      sessionId: asSessionId('s1'),
      name: 'feat-x',
      agentKind: 'claude-code',
      cwd: '/repo',
    },
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
    expect(buildBtwSeed({ session: { sessionId: asSessionId('s1') }, items })).not.toContain(
      'Summary:',
    )
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
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, (m) => {
      if (m.type === 'repoOpRequest') {
        queueMicrotask(() =>
          registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
            type: 'repoOpResult',
            requestId: m.requestId,
            ok: true,
            output: '',
          }),
        )
      }
    })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const sa = new SuperagentService(registry.modules, repos, registry.sessionStore)
    sa.history(FIRST_ADMIN_USER_ID)
    sa.startBtwTurn({ ownerUserId: FIRST_ADMIN_USER_ID, sessionId: asSessionId('s1') })
    sa.startBtwTurn({ ownerUserId: FIRST_ADMIN_USER_ID, sessionId: asSessionId('parent') })
    return { registry, sa }
  }

  it('passes title through and attributes spawn to the authenticated global thread', async () => {
    const { registry, sa } = harness()
    const out = JSON.parse(
      await sa.callMcpTool(
        'start_agent',
        {
          agentKind: 'claude-code',
          cwd: '/w',
          title: 'Investigate flake',
          confirmed: true,
        },
        asThreadId('global'),
      ),
    ) as { sessionId: string; cwd: string; agentKind: string }
    expect(out).toMatchObject({ cwd: '/w', agentKind: 'claude-code' })
    const meta = registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)
    expect(meta?.title).toBe('Investigate flake')
    expect(meta?.spawnedBy).toBe('superagent:global')
  })

  it('tags spawnedBy with the executing thread when known', async () => {
    const { registry, sa } = harness()
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', { agentKind: 'shell', cwd: '/w' }, asThreadId('btw_s1')),
    ) as { sessionId: string }
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)
        ?.spawnedBy,
    ).toBe('superagent:btw_s1')
  })

  it("issueId on a started issue spawns in the issue's worktree", async () => {
    const { registry, sa } = harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    registry.issues.update(issue.id, { worktreePath: '/r/.worktrees/issue-1-x', stage: 'planning' })
    const out = JSON.parse(
      await sa.callMcpTool(
        'start_agent',
        {
          agentKind: 'claude-code',
          cwd: '/ignored',
          issueId: issue.id,
          confirmed: true,
        },
        asThreadId('global'),
      ),
    ) as { sessionId: string; cwd: string }
    expect(out.cwd).toBe('/r/.worktrees/issue-1-x')
    const meta = registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)
    expect(meta?.cwd).toBe('/r/.worktrees/issue-1-x')
    expect(meta?.spawnedBy).toBe('superagent:global')
  })

  it('unstarted issue spawn preserves the exact initiating superagent thread', async () => {
    const { registry, sa } = harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    const out = JSON.parse(
      await sa.callMcpTool(
        'start_agent',
        {
          agentKind: 'claude-code',
          cwd: '/ignored',
          issueId: issue.id,
          confirmed: true,
        },
        asThreadId('btw_parent'),
      ),
    ) as { sessionId?: string; cwd: string }
    expect(out.cwd).toBe('/r/.worktrees/issue-1-fix-login')
    expect(out.sessionId).toBeDefined()
    const meta = registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)
    // IssueService owns worktree creation, but the initiating thread remains the parent.
    expect(meta?.spawnedBy).toBe('superagent:btw_parent')
    expect(registry.issues.get(issue.id)?.stage).toBe('in_progress')
  })

  it('works with issueId alone — cwd is optional when the issue provides it', async () => {
    const { registry, sa } = harness()
    const issue = registry.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    registry.issues.update(issue.id, { worktreePath: '/r/.worktrees/issue-1-x', stage: 'planning' })
    const out = JSON.parse(
      await sa.callMcpTool(
        'start_agent',
        {
          agentKind: 'claude-code',
          issueId: issue.id,
          confirmed: true,
        },
        asThreadId('global'),
      ),
    ) as { sessionId: string; cwd: string }
    expect(out.cwd).toBe('/r/.worktrees/issue-1-x')
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)?.cwd,
    ).toBe('/r/.worktrees/issue-1-x')
  })

  it('rejects a call with neither cwd nor issueId, spawning nothing', async () => {
    const { registry, sa } = harness()
    const out = await sa.callMcpTool('start_agent', { agentKind: 'claude-code', confirmed: true })
    expect(out).toMatch(/pass cwd or issueId/)
    expect(registry.modules.sessions.listSessions()).toHaveLength(0)
  })

  // Fail-closed identity (issue #67): a thread-blind MCP call can't be told apart
  // from a concierge one, so spawn-capable tools refuse without confirmed:true.
  it('fails closed on identity-less start-capable calls without confirmed', async () => {
    const { registry, sa } = harness()
    expect(await sa.callMcpTool('start_agent', { agentKind: 'claude-code', cwd: '/w' })).toBe(
      NOT_CONFIRMED_MSG,
    )
    expect(registry.modules.sessions.listSessions()).toHaveLength(0)
  })

  it('leaves non-spawning tools ungated for identity-less callers', async () => {
    const { sa } = harness()
    expect(JSON.parse(await sa.callMcpTool('list_sessions', {}))).toEqual([])
  })

  it('does not gate start-capable tools on known non-concierge threads', async () => {
    const { registry, sa } = harness()
    const out = JSON.parse(
      await sa.callMcpTool('start_agent', { agentKind: 'shell', cwd: '/w' }, asThreadId('global')),
    ) as { sessionId: string }
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === out.sessionId)
        ?.spawnedBy,
    ).toBe('superagent:global')
  })

  it('mints stable opaque per-thread MCP tokens and resolves them back', () => {
    const { sa } = harness()
    const tok = sa.mcpThreadToken(asThreadId('concierge_abc'))
    expect(tok).not.toContain('concierge_abc') // opaque, not the raw threadId
    expect(sa.mcpThreadToken(asThreadId('concierge_abc'))).toBe(tok) // stable per thread
    expect(sa.mcpThreadToken(asThreadId('btw_s1'))).not.toBe(tok)
    expect(sa.threadForMcpToken(tok)).toBe('concierge_abc')
    expect(sa.threadForMcpToken('no-such-token')).toBeUndefined()
  })

  it('rejects an unknown issue ref without spawning anything', async () => {
    const { registry, sa } = harness()
    const out = await sa.callMcpTool('start_agent', {
      agentKind: 'claude-code',
      cwd: '/w',
      issueId: 'iss_nope',
      confirmed: true,
    })
    expect(out).toMatch(/unknown issue/)
    expect(registry.modules.sessions.listSessions()).toHaveLength(0)
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
  it('dedupes repeated indices in a multi-select answer', () => {
    expect(matchAnswerToOptions('2,2', labels)).toEqual([2])
    expect(matchAnswerToOptions('1, 2, 1', labels)).toEqual([1, 2])
  })
})

// Session-steering belt (issue #62) — a real in-memory registry driven through
// callMcpTool, with a daemon fake that records inputs and answers transcript reads.
describe('session-steering tool belt (issue #62)', () => {
  const st = (phase: string, extra?: object) =>
    ({ phase, since: 't', nativeSubagentCount: 0, ...extra }) as never
  // The shape the claude-code classifier produces for a live on-screen
  // AskUserQuestion menu (agent-bridge ask_user_tool → needs_user/question).
  const pendingQuestion = st('needs_user', { need: { kind: 'question' } })

  function harness(opts?: { waitPollMs?: number; transcriptItems?: TranscriptItem[] }) {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const inputs: string[] = []
    registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, (m) => {
      if (m.type === 'input') inputs.push(Buffer.from(m.data, 'base64').toString())
      if (m.type === 'repoOpRequest') {
        queueMicrotask(() =>
          registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
            type: 'repoOpResult',
            requestId: m.requestId,
            ok: true,
            output: '',
          }),
        )
      }
      if (m.type === 'transcriptRead') {
        queueMicrotask(() =>
          registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
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
    const sa = new SuperagentService(registry.modules, repos, registry.sessionStore, {
      waitPollMs: opts?.waitPollMs ?? 5,
    })
    sa.history(FIRST_ADMIN_USER_ID)
    const spawn = (live = false): string => {
      const { sessionId } = registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      if (live)
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'bind',
          sessionId,
          cmd: 'claude',
          cwd: '/w',
          agentKind: 'claude-code',
          geometry: { cols: 80, rows: 24 },
        })
      return sessionId
    }
    const answer = (input: { sessionId: string; answer: string }) => {
      const threadId = asThreadId('answer_test')
      if (!registry.sessionStore.superagent.getSuperagentThread(threadId)) {
        const { sessionId } = registry.modules.sessions.createSession({
          agentKind: 'claude-code',
          cwd: '/w',
          spawnedBy: `superagent:${threadId}`,
        })
        registry.sessionStore.superagent.upsertSuperagentThread({ id: threadId, ownerUserId: FIRST_ADMIN_USER_ID, kind: 'global' })
        registry.sessionStore.superagent.updateSuperagentThreadBinding(threadId, {
          podiumSessionId: sessionId,
        })
      }
      return sa.callMcpTool('answer_question', input, threadId)
    }

    const metaOf = (id: string) =>
      registry.modules.sessions.listSessions().find((s) => s.sessionId === id)
    return { registry, sa, inputs, spawn, answer, metaOf }
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

  const markPending = (h: ReturnType<typeof harness>, sessionId: string) =>
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: pendingQuestion,
    })

  it('answer_question matches a label and types the option digit into the menu', async () => {
    const h = harness({ transcriptItems: [askItem()] })
    const sessionId = h.spawn(true)
    markPending(h, sessionId)
    const out = await h.answer({ sessionId, answer: 'No' })
    expect(JSON.parse(out)).toEqual({ answered: true, choices: [{ optionIndices: [2] }] })
    expect(h.inputs).toContain('2')
  })

  it('answer_question types multi-select numbers one at a time, then Tab and the confirm CR, deduped', async () => {
    const h = harness({ transcriptItems: [askItem(true)] })
    const sessionId = h.spawn(true)
    markPending(h, sessionId)
    const out = await h.answer({ sessionId, answer: '1,3,3' })
    expect(JSON.parse(out)).toEqual({
      answered: true,
      choices: [{ optionIndices: [1, 3], multiSelect: true }],
    })
    // The script outlives the call: the digits and their closing keys are paced
    // apart because the CLI folds a multi-character write into one dead key.
    await vi.waitFor(() => expect(h.inputs).toEqual(['1', '3', '\t', '\r']))
  })

  it('answer_question refuses when no question is pending (stale menu in the tail)', async () => {
    // The gate (issue #62 review): a stale, already-answered AskUserQuestion still
    // sits in the transcript tail while the agent WORKS — digits (or a submitting
    // Enter) must never reach the PTY, and the result must not claim success.
    const h = harness({ transcriptItems: [askItem()] })
    const sessionId = h.spawn(true)
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('working'),
    })
    const out = await h.answer({ sessionId, answer: 'Yes' })
    expect(out).toBe('no pending question (phase=working)')
    expect(h.inputs).toEqual([]) // zero PTY input
    // No agentState at all (phase unknown) is refused the same way.
    const h2 = harness({ transcriptItems: [askItem()] })
    const s2 = h2.spawn(true)
    expect(await h2.answer({ sessionId: s2, answer: 'Yes' })).toBe(
      'no pending question (phase=unknown)',
    )
  })

  it('answer_question notes single-select truncation instead of silently dropping picks', async () => {
    const h = harness({ transcriptItems: [askItem(false)] })
    const sessionId = h.spawn(true)
    markPending(h, sessionId)
    const out = JSON.parse(await h.answer({ sessionId, answer: '1,3' }))
    expect(out).toEqual({
      answered: true,
      choices: [{ optionIndices: [1] }],
      note: 'single-select — used first of 1,3',
    })
    expect(h.inputs).toContain('1')
  })

  it('answer_question rejects option indices beyond the native menu 1-9 range', async () => {
    const tenOptions = item({
      id: 'q1',
      role: 'tool',
      toolName: 'AskUserQuestion',
      toolInputJson: JSON.stringify({
        questions: [
          {
            question: 'Pick a branch',
            options: Array.from({ length: 10 }, (_, i) => ({ label: `branch-${i + 1}` })),
          },
        ],
      }),
    })
    const h = harness({ transcriptItems: [tenOptions] })
    const sessionId = h.spawn(true)
    markPending(h, sessionId)
    const out = await h.answer({ sessionId, answer: '10' })
    expect(out).toMatch(/option 10 is beyond the native menu's 1-9 range/)
    expect(h.inputs).toEqual([]) // nothing typed — no false success
  })

  it('answer_question reports unmatched answers with the option list, and missing prompts', async () => {
    const h = harness({ transcriptItems: [askItem()] })
    const sessionId = h.spawn(true)
    markPending(h, sessionId)
    expect(await h.answer({ sessionId, answer: 'maybe' })).toMatch(
      /could not match "maybe".*1\) Yes, 2\) No, 3\) Later/,
    )
    // Phase says pending but the tail has no structured prompt to answer from.
    const empty = harness()
    const s2 = empty.spawn(true)
    markPending(empty, s2)
    expect(await empty.answer({ sessionId: s2, answer: 'Yes' })).toMatch(
      /no pending AskUserQuestion/,
    )
  })

  it('answer_question rejects an unknown session', async () => {
    const h = harness()
    expect(await h.answer({ sessionId: asSessionId('nope'), answer: '1' })).toBe('unknown session')
  })

  it('answer_question fails closed without a bound transport identity', async () => {
    const h = harness({ transcriptItems: [askItem()] })
    const sessionId = h.spawn(true)
    markPending(h, sessionId)
    expect(
      await h.sa.callMcpTool('answer_question', { sessionId, answer: 'Yes' }),
    ).toBe('failed: answer caller identity unavailable')
    expect(h.inputs).toEqual([])
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
    expect(
      await h.sa.callMcpTool('resume_and_send', { sessionId: asSessionId('nope'), text: 'x' }),
    ).toBe('failed: unknown session')
  })

  it("continue_session types 'continue' into an errored live session only", async () => {
    const h = harness()
    const sessionId = h.spawn(true)
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('errored'),
    })
    expect(await h.sa.callMcpTool('continue_session', { sessionId })).toBe('sent continue')
    expect(h.inputs).toContain('continue\r')
    // Not errored anymore → refused, with the gate surfaced.
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('idle'),
    })
    expect(await h.sa.callMcpTool('continue_session', { sessionId })).toMatch(/errored phase/)
  })

  it('continue_session rejects an unknown session', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('continue_session', { sessionId: asSessionId('nope') })).toBe(
      'unknown session',
    )
  })

  it('hibernate_session parks a live session with a resume ref', async () => {
    const h = harness()
    const sessionId = h.spawn(true)
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId: asSessionId(sessionId),
      resume: { kind: 'claude-session', value: 'r1' },
    })
    expect(await h.sa.callMcpTool('hibernate_session', { sessionId })).toBe('hibernated')
    expect(h.metaOf(sessionId)?.status).toBe('hibernated')
  })

  it('hibernate_session surfaces the registry refusal reasons', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('hibernate_session', { sessionId: asSessionId('nope') })).toBe(
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
      await h.sa.callMcpTool(
        'snooze_session',
        { sessionId, until: 'next-message' },
        asThreadId('global'),
      ),
    ).toBe(JSON.stringify({ snoozedUntil: null }))
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeNull()
    // A FUTURE deadline. It used to be a fixed past date and still round-tripped,
    // because the projection read a `snoozedUntil` MIRROR on the live session that
    // never lapsed. POD-1076 deleted the mirror, so the projection reads the
    // `snoozes` table — which prunes lapsed timed snoozes on read, as it always
    // documented. The behaviour is strictly more correct (a client already ignores
    // lapsed snoozes at render time) and the assertion now needs a real deadline.
    const iso = '2999-07-03T05:00:00.000Z'
    await h.sa.callMcpTool('snooze_session', { sessionId, until: iso }, asThreadId('global'))
    expect(h.metaOf(sessionId)?.snoozedUntil).toBe(iso)
    expect(await h.sa.callMcpTool('clear_snooze', { sessionId }, asThreadId('global'))).toBe(
      'snooze cleared',
    )
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeUndefined()
  })

  it('a LAPSED timed snooze is not projected — the pruning read is now the only source', () => {
    // The counterfactual for the date change above, pinned so the two cannot drift:
    // an expired deadline must not surface. Before POD-1076 this could not be
    // asserted, because the mirror held the stale value until the next restart.
    const h = harness()
    const sessionId = asSessionId(h.spawn())
    // Through the SERVICE, not the store: a direct store write is invisible to the
    // projection's overlay cache, which is the same rule `IssueService.rows` has
    // always had. Driving the real entry point is also what makes this a test of
    // the shipped path rather than of the repository.
    h.registry.modules.sessions.setSnooze({
      userId: FIRST_ADMIN_USER_ID,
      sessionId,
      until: '2020-01-01T00:00:00.000Z',
    })
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeUndefined()
    // …while an open-ended snooze (null) never lapses by time. The counterfactual
    // that keeps the assertion above from passing for the wrong reason: if the
    // projection had simply stopped carrying snoozes, this would fail too.
    h.registry.modules.sessions.setSnooze({ userId: FIRST_ADMIN_USER_ID, sessionId, until: null })
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeNull()
  })

  it('snooze_session rejects garbage untils and unknown sessions', async () => {
    const h = harness()
    const sessionId = h.spawn()
    expect(await h.sa.callMcpTool('snooze_session', { sessionId, until: 'whenever' })).toMatch(
      /invalid until/,
    )
    expect(h.metaOf(sessionId)?.snoozedUntil).toBeUndefined()
    expect(
      await h.sa.callMcpTool('snooze_session', {
        sessionId: asSessionId('nope'),
        until: 'next-message',
      }),
    ).toBe('unknown session')
    expect(await h.sa.callMcpTool('clear_snooze', { sessionId: asSessionId('nope') })).toBe(
      'unknown session',
    )
  })

  it('rename_session sets the user-facing name', async () => {
    const h = harness()
    const sessionId = h.spawn()
    expect(await h.sa.callMcpTool('rename_session', { sessionId, name: 'auth fix' })).toBe(
      'renamed',
    )
    expect(h.metaOf(sessionId)?.name).toBe('auth fix')
    expect(
      await h.sa.callMcpTool('rename_session', { sessionId: asSessionId('nope'), name: 'x' }),
    ).toBe('unknown session')
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
      await h.sa.callMcpTool('set_work_state', {
        sessionId: asSessionId('nope'),
        workState: 'done',
      }),
    ).toBe('unknown session')
  })

  it('wait_for_session resolves early on the next phase event, with the verdict', async () => {
    const h = harness({ waitPollMs: 5 })
    const sessionId = h.spawn(true)
    // Seed a phase so the NEXT one is a real transition (prev==null logs nothing).
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('working'),
    })
    const p = h.sa.callMcpTool('wait_for_session', { sessionId, timeoutSeconds: 10 })
    await new Promise((r) => setTimeout(r, 15))
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('idle', { idle: { kind: 'done' } }),
    })
    expect(JSON.parse(await p)).toEqual({ phase: 'idle', verdict: 'done' })
  })

  it('wait_for_session returns instantly when the session is already settled', async () => {
    const h = harness({ waitPollMs: 60_000 }) // a poll sleep would blow the test timeout
    const sessionId = h.spawn(true)
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('idle', { idle: { kind: 'question' } }),
    })
    const t0 = Date.now()
    const out = await h.sa.callMcpTool('wait_for_session', { sessionId, timeoutSeconds: 120 })
    expect(JSON.parse(out)).toEqual({ phase: 'idle', verdict: 'question' })
    expect(Date.now() - t0).toBeLessThan(1000) // no wait, no poll
  })

  it('wait_for_session times out quietly with the last-known phase (never throws)', async () => {
    const h = harness({ waitPollMs: 5 })
    const sessionId = h.spawn(true)
    h.registry.gateway.routeDaemonFrame(h.registry.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: st('working'),
    })
    expect(await h.sa.callMcpTool('wait_for_session', { sessionId, timeoutSeconds: 0 })).toBe(
      'timeout after 0s (session still working)',
    )
  })

  it('wait_for_session rejects an unknown session', async () => {
    const h = harness()
    expect(await h.sa.callMcpTool('wait_for_session', { sessionId: asSessionId('nope') })).toBe(
      'unknown session',
    )
  })

  it('list_sessions rows carry spawnedBy + snoozedUntil', async () => {
    const h = harness()
    const { sessionId } = h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      spawnedBy: 'user',
    })
    h.registry.modules.sessions.setSnooze({ userId: FIRST_ADMIN_USER_ID, sessionId, until: null })
    const rows = JSON.parse(
      await h.sa.callMcpTool('list_sessions', {}, asThreadId('btw_x')),
    ) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ sessionId, spawnedBy: 'user', snoozedUntil: null })
  })
})
