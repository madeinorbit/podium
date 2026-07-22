// Headless superagent turns (concierge unification, Phase B): threads are
// persistent harness sessions — sendTurn acks before completion, progress fans
// out as headlessActivity frames, the harness session id becomes the thread's
// resume value, and "open in terminal" takes a one-writer lock.

import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { type HarnessAgent, nativeAccountId } from '@podium/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHandoffSeed,
  explicitlyRequestsExpandedResponse,
  NORMAL_RESPONSE_WORD_LIMIT,
  RESUME_KIND,
  SuperagentService,
  superagentResponseContract,
  TURN_FAILED_MARKER,
} from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

type TurnReq = Extract<ControlMessage, { type: 'headlessTurnRequest' }>
type BindReq = Extract<ControlMessage, { type: 'headlessBind' }>
type TurnAck = Extract<ControlMessage, { type: 'headlessTurnAck' }>
type SpawnMsg = Extract<ControlMessage, { type: 'spawn' }>

async function harness() {
  const registry = new SessionRegistry()
  registries.push(registry)
  const turnReqs: TurnReq[] = []
  const bindReqs: BindReq[] = []
  const spawns: SpawnMsg[] = []
  const interrupts: string[] = []
  registry.modules.sessions.attachDaemon('local', (m) => {
    if (m.type === 'headlessTurnRequest') turnReqs.push(m)
    if (m.type === 'headlessBind') bindReqs.push(m)
    if (m.type === 'spawn') spawns.push(m)
    if (m.type === 'headlessInterrupt') interrupts.push(m.sessionId)
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
    if (m.type === 'transcriptRead') {
      queueMicrotask(() =>
        registry.modules.sessions.onDaemonMessageFrom('local', {
          type: 'transcriptReadResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          items: [],
          hasMore: false,
        }),
      )
    }
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r')
  const sa = new SuperagentService(registry.modules, repos, registry.sessionStore)
  // A connected web client, to observe headlessActivity broadcasts.
  const clientMsgs: ServerMessage[] = []
  registry.modules.sessions.attachClient((m) => clientMsgs.push(m))
  const activity = () => clientMsgs.flatMap((m) => (m.type === 'headlessActivity' ? [m] : []))
  const resolveTurn = (
    req: TurnReq,
    result?: { ok?: boolean; error?: string; harnessSessionId?: string; output?: string },
  ) => {
    registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'headlessTurnResult',
      requestId: req.requestId,
      ok: result?.ok ?? true,
      ...(result?.error !== undefined ? { error: result.error } : {}),
      ...(result?.harnessSessionId !== undefined
        ? { harnessSessionId: result.harnessSessionId }
        : {}),
      ...(result?.output !== undefined ? { output: result.output } : {}),
    })
  }
  const settle = () => new Promise((r) => setTimeout(r))
  return {
    registry,
    repos,
    sa,
    turnReqs,
    bindReqs,
    spawns,
    interrupts,
    activity,
    resolveTurn,
    settle,
  }
}

describe('superagent response contract', () => {
  it.each([
    'Why?',
    'How did this happen?',
    'Explain the failure',
    'Why? Explain briefly.',
  ])('keeps ordinary diagnostics inside the normal budget: %s', (prompt) => {
    expect(explicitlyRequestsExpandedResponse(prompt)).toBe(false)
    expect(superagentResponseContract(prompt)).toContain(
      'HARD LIMIT ' + NORMAL_RESPONSE_WORD_LIMIT + ' words',
    )
  })

  it.each([
    'Give me a detailed explanation.',
    'I want a thorough answer.',
    'Provide a walkthrough of the failure.',
  ])('allows expansion only for an explicit cue: %s', (prompt) => {
    expect(explicitlyRequestsExpandedResponse(prompt)).toBe(true)
    expect(superagentResponseContract(prompt)).toContain('EXPANDED:')
  })

  it.each([
    "Don't give me a detailed answer.",
    'Is the detailed log present?',
    'Why is the walkthrough test failing?',
  ])('does not treat a negated or incidental cue as an opt-in: %s', (prompt) => {
    expect(explicitlyRequestsExpandedResponse(prompt)).toBe(false)
  })
})

describe('global thread priming, clear, and per-turn user focus (#225)', () => {
  it('re-primes with the seed after clear() — a cleared thread starts a fresh harness session', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'one' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const first = h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(first?.harnessSessionId).toBe('h1')
    const oldSessionId = first?.podiumSessionId
    expect(oldSessionId).toBeTruthy()

    h.sa.clear('global')

    // Binding dropped + old headless row disposed.
    const cleared = h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(cleared?.harnessSessionId).toBeUndefined()
    expect(cleared?.podiumSessionId).toBeUndefined()
    expect(
      h.registry.modules.sessions.listSessions().find((s) => s.sessionId === oldSessionId),
    ).toBeUndefined()

    // The next turn is a FIRST turn again: new session, no resume, re-primed.
    const ack = await h.sa.sendTurn({ threadId: 'global', text: 'two' })
    expect(ack.podiumSessionId).not.toBe(oldSessionId)
    const req = h.turnReqs[1]!
    expect(req.resumeValue).toBeUndefined()
    expect(req.prompt).toBe('two')
    expect(req.contextPrompt).toContain('[SUPERAGENT CONTEXT]')
  })

  it('binds the harness session even when the FIRST turn fails — the thread keeps its conversation', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    // The harness minted a session, then the turn died (interrupt / tool crash /
    // error_during_execution). The conversation exists on disk.
    h.resolveTurn(h.turnReqs[0]!, {
      ok: false,
      error: 'claude turn failed: error_during_execution',
      harnessSessionId: 'h1',
    })
    await h.settle()

    const thread = h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(thread?.harnessSessionId).toBe('h1')
    // The headless session carries the resume ref, so its transcript binds...
    const meta = h.registry.modules.sessions
      .listSessions()
      .find((s) => s.sessionId === podiumSessionId)
    expect(meta?.resume).toMatchObject({ kind: RESUME_KIND['claude-code'], value: 'h1' })
    // ...and the NEXT turn RESUMES rather than silently starting a new conversation.
    await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    expect(h.turnReqs[1]?.resumeValue).toBe('h1')
    h.resolveTurn(h.turnReqs[1]!)
    await h.settle()
    // "Open in terminal" is available again (it gates on harnessSessionId).
    await expect(h.sa.openInTerminal({ threadId: 'global' })).resolves.toBeDefined()
  })

  it('refuses to clear while a turn is running', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(() => h.sa.clear('global')).toThrow(/turn is running/)
  })

  it('clear RELEASES a terminal lock — a locked thread can always be reset', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const { sessionId } = await h.sa.openInTerminal({ threadId: 'global' })
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'x' })).rejects.toThrow(
      /open in a terminal/,
    )

    h.sa.clear('global')

    const thread = h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(thread?.terminalSessionId).toBeUndefined()
    // The PTY session the user opened keeps running — only the binding was dropped.
    expect(
      h.registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId),
    ).toBeTruthy()
    // And chatting works again, from a freshly primed session.
    const ack = await h.sa.sendTurn({ threadId: 'global', text: 'back to chat' })
    expect(ack.podiumSessionId).toBeTruthy()
    expect(h.turnReqs.at(-1)?.prompt).toBe('back to chat')
    expect(h.turnReqs.at(-1)?.contextPrompt).toContain('[SUPERAGENT CONTEXT]')
  })

  it('prepends what the user is looking at to EVERY turn, resolving ids server-side', async () => {
    const h = await harness()
    // A real session to focus, and the issue it belongs to.
    const issue = h.registry.issues.create({
      repoPath: '/r',
      title: 'Fix the thing',
      startNow: false,
    })
    const { sessionId } = h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })

    await h.sa.sendTurn({
      threadId: 'global',
      text: 'why is this stuck?',
      focus: {
        view: 'workspace',
        worktreePath: '/r',
        issueId: issue.id,
        focusedSessionId: sessionId,
        visibleSessionIds: [sessionId],
      },
    })
    expect(h.turnReqs[0]?.prompt).toBe('why is this stuck?')
    const first = h.turnReqs[0]?.contextPrompt ?? ''
    expect(first).toContain('[USER VIEW @')
    expect(first).toContain(`#${issue.seq} "Fix the thing"`)
    expect(first).toContain('Worktree in view: /r')
    expect(first).toContain('Focused pane:')
    // The block sits closest to the user's message.
    expect(first.indexOf('[USER VIEW @')).toBeGreaterThan(first.indexOf('[SUPERAGENT CONTEXT]'))

    // And on LATER turns too — not just the primed first one.
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    await h.sa.sendTurn({ threadId: 'global', text: 'and now?', focus: { view: 'issues' } })
    expect(h.turnReqs[1]?.prompt).toBe('and now?')
    const second = h.turnReqs[1]?.contextPrompt ?? ''
    expect(second).toContain('[USER VIEW @')
    expect(second).toContain('Screen: issues')
    expect(second).not.toContain('[SUPERAGENT CONTEXT]') // seed is first-turn only
  })

  it('omits the block entirely when the caller reports no focus (MCP/automation turns)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(h.turnReqs[0]?.prompt).toBe('hi')
    expect(h.turnReqs[0]?.contextPrompt).not.toContain('[USER VIEW')
  })
})

describe('sendTurn (headless harness turns)', () => {
  it('acks before completion, creates the headless session, and dispatches the turn', async () => {
    const h = await harness()
    const ack = await h.sa.sendTurn({ threadId: 'global', text: 'hello' })
    expect(ack.threadId).toBe('global')
    expect(ack.podiumSessionId).toBeTruthy()
    // The turn was DISPATCHED but not completed — ack came first.
    expect(h.turnReqs).toHaveLength(1)
    const req = h.turnReqs[0]!
    expect(req.agent).toBe('claude-code') // settings default frozen on
    // Global thread: machine context stays separate from the human message.
    expect(req.prompt).toBe('hello')
    expect(req.contextPrompt).toContain('[SUPERAGENT CONTEXT]')
    expect(req.contextPrompt).toContain('/r')
    expect(req.permissionMode).toBe('auto')
    expect(req.systemPrompt).toContain('superagent')
    expect(req.resumeValue).toBeUndefined() // first turn
    expect(req.sessionUuid).toBeTruthy() // claude: deterministic session uuid
    // The headless Podium session exists: live, PTY-less (no spawn message), flagged.
    const meta = h.registry.modules.sessions
      .listSessions()
      .find((s) => s.sessionId === ack.podiumSessionId)
    expect(meta).toMatchObject({ status: 'live', headless: true, spawnedBy: 'superagent:global' })
    expect(h.spawns).toHaveLength(0)
    // The agent is frozen onto the thread row.
    expect(h.registry.sessionStore.superagent.getSuperagentThread('global')?.agentKind).toBe(
      'claude-code',
    )
  })

  it('forwards turn events + boundary markers as headlessActivity broadcasts', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    const req = h.turnReqs[0]!
    h.registry.modules.sessions.onDaemonMessageFrom('local', {
      type: 'headlessTurnEvent',
      requestId: req.requestId,
      sessionId: podiumSessionId,
      event: { kind: 'partial-text', text: 'thinking…' },
    })
    h.resolveTurn(req, { harnessSessionId: 'h1' })
    await h.settle()
    const events = h.activity().map((m) => m.event)
    expect(events[0]).toEqual({ kind: 'turn-start' })
    expect(events).toContainEqual({ kind: 'partial-text', text: 'thinking…' })
    expect(events.at(-1)).toEqual({ kind: 'turn-end' })
    expect(h.activity().every((m) => m.sessionId === podiumSessionId)).toBe(true)
  })

  it('persists the harness session id as the resume value after the first turn', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'harness-1' })
    await h.settle()
    // Thread row carries the harness session id…
    expect(h.registry.sessionStore.superagent.getSuperagentThread('global')?.harnessSessionId).toBe(
      'harness-1',
    )
    // …and the session's resume ref uses the same per-kind convention PTY rows use.
    const meta = h.registry.modules.sessions
      .listSessions()
      .find((s) => s.sessionId === podiumSessionId)
    expect(meta?.resume).toEqual({ kind: 'claude-session', value: 'harness-1' })
    // Persisted (survives a reload).
    const row = h.registry.sessionStore.sessions
      .loadSessions()
      .find((r) => r.id === podiumSessionId)
    expect(row).toMatchObject({ resumeKind: 'claude-session', resumeValue: 'harness-1' })
    // The second turn resumes — same session, resumeValue set, no new uuid.
    await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    const second = h.turnReqs[1]!
    expect(second.sessionId).toBe(podiumSessionId)
    expect(second.resumeValue).toBe('harness-1')
    expect(second.sessionUuid).toBeUndefined()
  })

  it('reasserts the normal budget on a resumed Claude thread after an expanded turn', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'Give me a detailed walkthrough.' })
    const first = h.turnReqs[0]!
    expect(first.systemPrompt).toContain('EXPANDED:')
    h.resolveTurn(first, { harnessSessionId: 'claude-thread-1' })
    await h.settle()

    await h.sa.sendTurn({ threadId: 'global', text: 'Why?' })
    const resumed = h.turnReqs[1]!
    expect(resumed.resumeValue).toBe('claude-thread-1')
    expect(resumed.systemPrompt).toContain(
      'NORMAL: HARD LIMIT ' + NORMAL_RESPONSE_WORD_LIMIT + ' words',
    )
    expect(resumed.systemPrompt).not.toContain('EXPANDED:')
  })

  it('rejects a second send while a turn is running (per-thread turn lock)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'one' })
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'two' })).rejects.toThrow(
      /turn is already running/,
    )
    // Completion releases the lock.
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'three' })).resolves.toBeTruthy()
  })

  it('a failed turn records a persisted notice, broadcasts the error, and unlocks', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { ok: false, error: 'claude: command not found' })
    await h.settle()
    // Honest, persisted failure — no silent fallback to the buffered path. The
    // raw harness stderr is interpreted into a user-facing message (POD-1021):
    // "command not found" → a "CLI couldn't be launched" notice.
    const notice = h.sa.history('global').find((m) => m.content.startsWith(TURN_FAILED_MARKER))
    expect(notice?.content).toMatch(/Claude CLI couldn't be launched/)
    expect(
      h
        .activity()
        .map((m) => m.event)
        .at(-1),
    ).toEqual({
      kind: 'turn-end',
      error: "The Claude CLI couldn't be launched — it isn't installed or isn't on PATH.",
    })
    // No harness session was learned; the next send is a fresh first turn again.
    expect(
      h.registry.sessionStore.superagent.getSuperagentThread('global')?.harnessSessionId,
    ).toBeUndefined()
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'retry' })).resolves.toBeTruthy()
  })

  it('keeps legacy buffered history readable; successful turns add nothing to it', async () => {
    const h = await harness()
    const store = h.registry.sessionStore
    store.superagent.appendSuperagentMessage('global', { role: 'user', content: 'old question' })
    store.superagent.appendSuperagentMessage('global', { role: 'assistant', content: 'old answer' })
    await h.sa.sendTurn({ threadId: 'global', text: 'new turn' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1', output: 'new answer' })
    await h.settle()
    // The transcript is the truth for new turns — superagent_messages is frozen.
    expect(h.sa.history('global').map((m) => m.content)).toEqual(['old question', 'old answer'])
  })

  it('rejects an unknown thread', async () => {
    const h = await harness()
    await expect(h.sa.sendTurn({ threadId: 'btw_nope', text: 'x' })).rejects.toThrow(
      /unknown thread/,
    )
  })

  it('mounts MCP config + allowedTools for MCP-capable agents when the endpoint is up', async () => {
    const h = await harness()
    h.sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'route-tok', ['list_sessions', 'issue_list'])
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    const req = h.turnReqs[0]!
    expect(req.allowedTools).toContain('mcp__podium__issue_list')
    const cfg = JSON.parse(req.mcpConfig ?? '{}') as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>
    }
    expect(cfg.mcpServers.podium?.url).toBe('http://127.0.0.1:1878/mcp')
    expect(cfg.mcpServers.podium?.headers['x-podium-mcp-token']).toBe('route-tok')
    expect(
      h.sa.threadForMcpToken(cfg.mcpServers.podium?.headers['x-podium-mcp-thread'] ?? ''),
    ).toBe('global')
  })
})

describe('conciergeTurn / startBtwTurn (thread creation on the headless path)', () => {
  it('first concierge turn prepends the tracker seed; re-entry prepends the event delta', async () => {
    const h = await harness()
    h.registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    const a = await h.sa.conciergeTurn({ repoPath: '/r', text: 'status?' })
    expect(a.isNew).toBe(true)
    const first = h.turnReqs[0]!
    expect(first.prompt).toBe('status?')
    expect(first.contextPrompt).toContain('[CONCIERGE CONTEXT]')
    expect(first.contextPrompt).toContain('Fix login')
    expect(first.systemPrompt).toContain('concierge for /r')
    expect(first.cwd).toBe('/r')
    h.resolveTurn(first, { harnessSessionId: 'hc1' })
    await h.settle()
    // New tracker activity → the next turn carries a delta, not a re-seed.
    h.registry.issues.create({ repoPath: '/r', title: 'New work', startNow: false })
    const b = await h.sa.conciergeTurn({ repoPath: '/r', text: 'what changed?' })
    expect(b.isNew).toBe(false)
    expect(b.threadId).toBe(a.threadId)
    const second = h.turnReqs[1]!
    expect(second.resumeValue).toBe('hc1')
    expect(second.prompt).toBe('what changed?')
    expect(second.contextPrompt).toContain('[CONCIERGE UPDATE')
    expect(second.contextPrompt).toContain('created "New work"')
    expect(second.contextPrompt).not.toContain('[CONCIERGE CONTEXT]')
    // No gap → no delta block on the third turn.
    h.resolveTurn(second)
    await h.settle()
    await h.sa.conciergeTurn({ repoPath: '/r', text: 'and now?' })
    expect(h.turnReqs[2]?.prompt).toBe('and now?')
    expect(h.turnReqs[2]?.contextPrompt).toBeUndefined()
  })

  it('rejects an unregistered repo without minting a thread', async () => {
    const h = await harness()
    await expect(h.sa.conciergeTurn({ repoPath: '/typo', text: 'hi' })).rejects.toThrow(
      /unknown repo/,
    )
    expect(h.sa.listThreads().filter((t) => t.kind === 'concierge')).toHaveLength(0)
  })

  it('startBtwTurn ensures the thread; the first send seeds from the origin transcript', async () => {
    const h = await harness()
    const { sessionId } = h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    const res = h.sa.startBtwTurn({ sessionId })
    expect(res).toEqual({ threadId: `btw_${sessionId}`, isNew: true })
    expect(h.sa.startBtwTurn({ sessionId })).toEqual({
      threadId: `btw_${sessionId}`,
      isNew: false,
    })
    await h.sa.sendTurn({ threadId: res.threadId, text: 'what is this session doing?' })
    const req = h.turnReqs.find((r) => r.threadId === res.threadId)!
    expect(req.prompt).toBe('what is this session doing?')
    expect(req.contextPrompt).toContain('[BTW CONTEXT]')
    expect(req.contextPrompt).toContain(sessionId)
    expect(req.cwd).toBe('/w') // origin session's cwd
  })
})

describe('openInTerminal + one-writer lock', () => {
  async function threadWithHarnessSession() {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    return h
  }

  it('opens a normal PTY session with the per-agent resume ref and locks the thread', async () => {
    const h = await threadWithHarnessSession()
    const { sessionId } = await h.sa.openInTerminal({ threadId: 'global' })
    // A REAL spawn went to the daemon, carrying the harness resume ref.
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]).toMatchObject({
      sessionId,
      agentKind: 'claude-code',
      resume: { kind: RESUME_KIND['claude-code'], value: 'h1' },
    })
    const meta = h.registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(meta?.headless).toBeUndefined() // a normal PTY session
    expect(
      h.registry.sessionStore.superagent.getSuperagentThread('global')?.terminalSessionId,
    ).toBe(sessionId)
    // One writer: sendTurn refuses while the terminal session is alive.
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'x' })).rejects.toThrow(
      /open in a terminal/,
    )
    // The lock clears lazily once the terminal session is gone.
    h.registry.modules.sessions.killSession({ sessionId })
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'x' })).resolves.toBeTruthy()
    expect(
      h.registry.sessionStore.superagent.getSuperagentThread('global')?.terminalSessionId,
    ).toBeUndefined()
  })

  it('refuses before a harness session exists and while a turn is running', async () => {
    const h = await harness()
    await expect(h.sa.openInTerminal({ threadId: 'global' })).rejects.toThrow(/no harness session/)
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    await expect(h.sa.openInTerminal({ threadId: 'global' })).rejects.toThrow(/turn is running/)
  })

  it('interruptTurn routes to the headless session', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.sa.interruptTurn({ threadId: 'global' })
    expect(h.interrupts).toEqual([podiumSessionId])
    expect(() => h.sa.interruptTurn({ threadId: 'btw_none' })).toThrow(/no headless session/)
  })
})

describe('boot reconciliation for headless sessions', () => {
  it('persists raw input before async context preparation and resumes it after restart', async () => {
    const h = await harness()
    const stalled = h.sa as unknown as {
      composeContext: () => Promise<undefined>
    }
    stalled.composeContext = () => new Promise(() => {})

    void h.sa.sendTurn({
      threadId: 'global',
      text: 'accepted before preparation',
      focus: { view: 'issues' },
    })
    expect(h.registry.sessionStore.superagent.listQueuedInputs()).toMatchObject([
      {
        threadId: 'global',
        text: 'accepted before preparation',
        focus: { view: 'issues' },
      },
    ])
    expect(h.registry.sessionStore.superagent.listPendingTurns()).toHaveLength(0)

    const store = h.registry.sessionStore
    const reborn = new SessionRegistry(store)
    registries.push(reborn)
    const replayed: TurnReq[] = []
    reborn.modules.sessions.attachDaemon('local', (message) => {
      if (message.type === 'headlessTurnRequest') replayed.push(message)
    })
    const repos = new RepoRegistry(reborn, store)
    const superagent = new SuperagentService(reborn.modules, repos, store)
    superagent.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'fresh-token')
    await new Promise((resolve) => setTimeout(resolve))

    expect(store.superagent.listQueuedInputs()).toHaveLength(0)
    expect(store.superagent.listPendingTurns()).toHaveLength(1)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({
      prompt: 'accepted before preparation',
      contextPrompt: expect.stringContaining('[USER VIEW @'),
    })
  })

  it('replays an accepted in-flight message with the same turn id after a server restart', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'survive restart' })
    const original = h.turnReqs[0]!
    expect(h.registry.sessionStore.superagent.listPendingTurns()).toHaveLength(1)

    const store = h.registry.sessionStore
    const reborn = new SessionRegistry(store)
    registries.push(reborn)
    const replayed: TurnReq[] = []
    const acknowledgements: TurnAck[] = []
    reborn.modules.sessions.attachDaemon('local', (message) => {
      if (message.type === 'headlessTurnRequest') replayed.push(message)
      if (message.type === 'headlessTurnAck') acknowledgements.push(message)
    })
    const repos = new RepoRegistry(reborn, store)
    const superagent = new SuperagentService(reborn.modules, repos, store)
    superagent.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'fresh-token')
    await new Promise((resolve) => setTimeout(resolve))

    expect(replayed).toHaveLength(1)
    const replay = replayed[0]
    if (!replay) throw new Error('pending turn was not replayed')
    expect(replay).toMatchObject({
      turnId: original.turnId,
      sessionId: original.sessionId,
      prompt: 'survive restart',
    })
    expect(replay.contextPrompt).toContain('[SUPERAGENT CONTEXT]')

    reborn.modules.sessions.onDaemonMessageFrom('local', {
      type: 'headlessTurnResult',
      requestId: replay.requestId,
      ok: true,
      harnessSessionId: 'recovered-harness',
      output: 'done',
    })
    await new Promise((resolve) => setTimeout(resolve))

    expect(store.superagent.listPendingTurns()).toHaveLength(0)
    expect(acknowledgements).toContainEqual({
      type: 'headlessTurnAck',
      turnId: original.turnId,
      sessionId: original.sessionId,
    })
    await expect(
      superagent.sendTurn({ threadId: 'global', text: 'next message' }),
    ).resolves.toBeTruthy()
  })

  it('stays live across a restart and rebinds tails via headlessBind (no reattach probe)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const sessionId =
      h.registry.sessionStore.superagent.getSuperagentThread('global')?.podiumSessionId
    // "Restart": a fresh registry over the same store.
    const store = h.registry.sessionStore
    const reborn = new SessionRegistry(store)
    registries.push(reborn)
    const binds: BindReq[] = []
    const reattaches: string[] = []
    reborn.modules.sessions.attachDaemon('local', (m) => {
      if (m.type === 'headlessBind') {
        binds.push(m)
        queueMicrotask(() =>
          reborn.modules.sessions.onDaemonMessageFrom('local', {
            type: 'headlessBindResult',
            requestId: m.requestId,
            ok: true,
          }),
        )
      }
      if (m.type === 'reattach') reattaches.push(m.sessionId)
    })
    await new Promise((r) => setTimeout(r))
    const meta = reborn.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    // Not demoted to reconnecting/exited — headless sessions have no PTY to probe.
    expect(meta?.status).toBe('live')
    expect(meta?.headless).toBe(true)
    expect(reattaches).not.toContain(sessionId)
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatchObject({
      sessionId,
      agentKind: 'claude-code',
      resumeValue: 'h1',
    })
  })
})

describe('harness switch + effort (#199)', () => {
  const setSuperagentHarness = (
    h: Awaited<ReturnType<typeof harness>>,
    patch: { harness?: HarnessAgent; model?: string; effort?: string },
  ) => {
    const cur = h.registry.sessionStore.settings.getSettings()
    const harness = patch.harness ?? 'claude-code'
    h.registry.sessionStore.settings.setSettings({
      ...cur,
      roles: {
        ...cur.roles,
        superagent: {
          ...cur.roles.superagent,
          accountId: nativeAccountId(harness),
          harness,
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        },
      },
    })
  }

  it('switches the harness when the setting changes, starting a fresh session', async () => {
    const h = await harness()
    // First turn freezes claude-code and learns a harness session id.
    const first = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    expect(h.turnReqs[0]?.agent).toBe('claude-code')

    // User picks a different harness in settings.
    setSuperagentHarness(h, { harness: 'codex' })
    const second = await h.sa.sendTurn({ threadId: 'global', text: 'still there?' })

    const req = h.turnReqs[1]!
    expect(req.agent).toBe('codex') // switched
    expect(req.resumeValue).toBeUndefined() // fresh session, not resuming claude-1
    expect(second.podiumSessionId).not.toBe(first.podiumSessionId) // new headless row
    // The thread is re-bound to the new harness.
    expect(h.registry.sessionStore.superagent.getSuperagentThread('global')?.agentKind).toBe(
      'codex',
    )
    expect(
      h.registry.sessionStore.superagent.getSuperagentThread('global')?.harnessSessionId,
    ).toBeFalsy()
  })

  it('does not switch when the setting is unchanged (resumes)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    expect(h.turnReqs[1]?.agent).toBe('claude-code')
    expect(h.turnReqs[1]?.resumeValue).toBe('claude-1') // same session
  })

  it('restartThread resets the harness session so the next turn is fresh', async () => {
    const h = await harness()
    const first = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    h.sa.restartThread({ threadId: 'global' })
    const row = h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(row?.harnessSessionId).toBeFalsy()
    expect(row?.podiumSessionId).toBeFalsy()
    expect(row?.agentKind).toBe('claude-code') // agent kept, only the session reset
    const second = await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    expect(second.podiumSessionId).not.toBe(first.podiumSessionId) // fresh session
    expect(h.turnReqs[1]?.resumeValue).toBeUndefined()
  })

  it('plumbs harnessEffort into the turn request; auto sends none', async () => {
    const h = await harness()
    setSuperagentHarness(h, { harness: 'claude-code', effort: 'high' })
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(h.turnReqs[0]?.effort).toBe('high')

    const h2 = await harness()
    setSuperagentHarness(h2, { harness: 'claude-code', effort: 'auto' })
    await h2.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(h2.turnReqs[0]?.effort).toBeUndefined()
  })

  it('uses a native Codex superagent model even when coding uses another harness', async () => {
    const h = await harness()
    const current = h.registry.sessionStore.settings.getSettings()
    h.registry.sessionStore.settings.setSettings({
      ...current,
      roles: {
        ...current.roles,
        coding: {
          ...current.roles.coding,
          accountId: nativeAccountId('grok'),
          model: 'grok-build',
          effort: 'low',
        },
        // Existing settings blobs can predate the explicit harness field.
        superagent: {
          accountId: nativeAccountId('codex'),
          model: 'gpt-5.5',
          effort: 'xhigh',
        },
      },
    })

    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })

    expect(h.turnReqs[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    })
  })
})

describe('buildHandoffSeed (#199)', () => {
  it('frames the handoff and digests the outgoing transcript', () => {
    const seed = buildHandoffSeed({
      from: 'claude-code',
      to: 'codex',
      items: [
        { id: '1', role: 'user', text: 'add a login page', ts: 't1' },
        { id: '2', role: 'assistant', text: 'done', ts: 't2' },
        { id: '3', role: 'tool', toolName: 'Edit', toolInput: 'login.tsx', text: '', ts: 't3' },
      ],
    })
    expect(seed).toContain('[HANDOFF]')
    expect(seed).toContain('from claude-code')
    expect(seed).toContain('to codex')
    expect(seed).toContain('add a login page') // user message carried verbatim
    expect(seed).toContain('Recap:') // deterministic recap included
  })

  it('is empty-safe', () => {
    expect(() => buildHandoffSeed({ from: 'codex', to: 'grok', items: [] })).not.toThrow()
  })
})
