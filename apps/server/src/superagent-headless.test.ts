// Headless superagent turns (concierge unification, Phase B): threads are
// persistent harness sessions — sendTurn acks before completion, progress fans
// out as headlessActivity frames, the harness session id becomes the thread's
// resume value, and "open in terminal" takes a one-writer lock.
import { type HarnessAgent, nativeAccountId } from '@podium/core'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { buildHandoffSeed, RESUME_KIND, SuperagentService, TURN_FAILED_MARKER } from './superagent'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

type TurnReq = Extract<ControlMessage, { type: 'headlessTurnRequest' }>
type BindReq = Extract<ControlMessage, { type: 'headlessBind' }>
type SpawnMsg = Extract<ControlMessage, { type: 'spawn' }>

async function harness() {
  const registry = new SessionRegistry()
  registries.push(registry)
  const turnReqs: TurnReq[] = []
  const bindReqs: BindReq[] = []
  const spawns: SpawnMsg[] = []
  const interrupts: string[] = []
  registry.attachDaemon('local', (m) => {
    if (m.type === 'headlessTurnRequest') turnReqs.push(m)
    if (m.type === 'headlessBind') bindReqs.push(m)
    if (m.type === 'spawn') spawns.push(m)
    if (m.type === 'headlessInterrupt') interrupts.push(m.sessionId)
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
          items: [],
          hasMore: false,
        }),
      )
    }
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r')
  const sa = new SuperagentService(registry, repos, registry.sessionStore)
  // A connected web client, to observe headlessActivity broadcasts.
  const clientMsgs: ServerMessage[] = []
  registry.attachClient((m) => clientMsgs.push(m))
  const activity = () => clientMsgs.flatMap((m) => (m.type === 'headlessActivity' ? [m] : []))
  const resolveTurn = (
    req: TurnReq,
    result?: { ok?: boolean; error?: string; harnessSessionId?: string; output?: string },
  ) => {
    registry.onDaemonMessageFrom('local', {
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

describe('global thread priming, clear, and per-turn user focus (#225)', () => {
  it('re-primes with the seed after clear() — a cleared thread starts a fresh harness session', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'one' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const first = h.registry.sessionStore.getSuperagentThread('global')
    expect(first?.harnessSessionId).toBe('h1')
    const oldSessionId = first?.podiumSessionId
    expect(oldSessionId).toBeTruthy()

    h.sa.clear('global')

    // Binding dropped + old headless row disposed.
    const cleared = h.registry.sessionStore.getSuperagentThread('global')
    expect(cleared?.harnessSessionId).toBeUndefined()
    expect(cleared?.podiumSessionId).toBeUndefined()
    expect(h.registry.listSessions().find((s) => s.sessionId === oldSessionId)).toBeUndefined()

    // The next turn is a FIRST turn again: new session, no resume, re-primed.
    const ack = await h.sa.sendTurn({ threadId: 'global', text: 'two' })
    expect(ack.podiumSessionId).not.toBe(oldSessionId)
    const req = h.turnReqs[1]!
    expect(req.resumeValue).toBeUndefined()
    expect(req.prompt).toContain('[SUPERAGENT CONTEXT]')
  })

  it('refuses to clear while a turn is running', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(() => h.sa.clear('global')).toThrow(/turn is running/)
  })

  it('prepends what the user is looking at to EVERY turn, resolving ids server-side', async () => {
    const h = await harness()
    // A real session to focus, and the issue it belongs to.
    const issue = h.registry.issues.create({
      repoPath: '/r',
      title: 'Fix the thing',
      startNow: false,
    })
    const { sessionId } = h.registry.createSession({ agentKind: 'claude-code', cwd: '/r' })

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
    const first = h.turnReqs[0]!.prompt
    expect(first).toContain('[USER VIEW @')
    expect(first).toContain(`#${issue.seq} "Fix the thing"`)
    expect(first).toContain('Worktree in view: /r')
    expect(first).toContain('Focused pane:')
    // The block sits closest to the user's message.
    expect(first.indexOf('[USER VIEW @')).toBeGreaterThan(first.indexOf('[SUPERAGENT CONTEXT]'))
    expect(first.endsWith('why is this stuck?')).toBe(true)

    // And on LATER turns too — not just the primed first one.
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    await h.sa.sendTurn({ threadId: 'global', text: 'and now?', focus: { view: 'issues' } })
    const second = h.turnReqs[1]!.prompt
    expect(second).toContain('[USER VIEW @')
    expect(second).toContain('Screen: issues')
    expect(second).not.toContain('[SUPERAGENT CONTEXT]') // seed is first-turn only
  })

  it('omits the block entirely when the caller reports no focus (MCP/automation turns)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(h.turnReqs[0]!.prompt).not.toContain('[USER VIEW')
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
    // Global thread: primed with the cross-repo digest seed, then the message.
    expect(req.prompt).toContain('[SUPERAGENT CONTEXT]')
    expect(req.prompt).toContain('/r')
    expect(req.prompt.endsWith('hello')).toBe(true)
    expect(req.systemPrompt).toContain('superagent')
    expect(req.resumeValue).toBeUndefined() // first turn
    expect(req.sessionUuid).toBeTruthy() // claude: deterministic session uuid
    // The headless Podium session exists: live, PTY-less (no spawn message), flagged.
    const meta = h.registry.listSessions().find((s) => s.sessionId === ack.podiumSessionId)
    expect(meta).toMatchObject({ status: 'live', headless: true, spawnedBy: 'superagent:global' })
    expect(h.spawns).toHaveLength(0)
    // The agent is frozen onto the thread row.
    expect(h.registry.sessionStore.getSuperagentThread('global')?.agentKind).toBe('claude-code')
  })

  it('forwards turn events + boundary markers as headlessActivity broadcasts', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    const req = h.turnReqs[0]!
    h.registry.onDaemonMessageFrom('local', {
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
    expect(h.registry.sessionStore.getSuperagentThread('global')?.harnessSessionId).toBe(
      'harness-1',
    )
    // …and the session's resume ref uses the same per-kind convention PTY rows use.
    const meta = h.registry.listSessions().find((s) => s.sessionId === podiumSessionId)
    expect(meta?.resume).toEqual({ kind: 'claude-session', value: 'harness-1' })
    // Persisted (survives a reload).
    const row = h.registry.sessionStore.loadSessions().find((r) => r.id === podiumSessionId)
    expect(row).toMatchObject({ resumeKind: 'claude-session', resumeValue: 'harness-1' })
    // The second turn resumes — same session, resumeValue set, no new uuid.
    await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    const second = h.turnReqs[1]!
    expect(second.sessionId).toBe(podiumSessionId)
    expect(second.resumeValue).toBe('harness-1')
    expect(second.sessionUuid).toBeUndefined()
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
    // Honest, persisted failure — no silent fallback to the buffered path.
    const notice = h.sa.history('global').find((m) => m.content.startsWith(TURN_FAILED_MARKER))
    expect(notice?.content).toContain('claude: command not found')
    expect(
      h
        .activity()
        .map((m) => m.event)
        .at(-1),
    ).toEqual({
      kind: 'turn-end',
      error: 'claude: command not found',
    })
    // No harness session was learned; the next send is a fresh first turn again.
    expect(h.registry.sessionStore.getSuperagentThread('global')?.harnessSessionId).toBeUndefined()
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'retry' })).resolves.toBeTruthy()
  })

  it('keeps legacy buffered history readable; successful turns add nothing to it', async () => {
    const h = await harness()
    const store = h.registry.sessionStore
    store.appendSuperagentMessage('global', { role: 'user', content: 'old question' })
    store.appendSuperagentMessage('global', { role: 'assistant', content: 'old answer' })
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
    expect(first.prompt).toContain('[CONCIERGE CONTEXT]')
    expect(first.prompt).toContain('Fix login')
    expect(first.prompt.endsWith('status?')).toBe(true)
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
    expect(second.prompt).toContain('[CONCIERGE UPDATE')
    expect(second.prompt).toContain('created "New work"')
    expect(second.prompt).not.toContain('[CONCIERGE CONTEXT]')
    // No gap → no delta block on the third turn.
    h.resolveTurn(second)
    await h.settle()
    await h.sa.conciergeTurn({ repoPath: '/r', text: 'and now?' })
    expect(h.turnReqs[2]?.prompt).toBe('and now?')
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
    const { sessionId } = h.registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const res = h.sa.startBtwTurn({ sessionId })
    expect(res).toEqual({ threadId: `btw_${sessionId}`, isNew: true })
    expect(h.sa.startBtwTurn({ sessionId })).toEqual({
      threadId: `btw_${sessionId}`,
      isNew: false,
    })
    await h.sa.sendTurn({ threadId: res.threadId, text: 'what is this session doing?' })
    const req = h.turnReqs.find((r) => r.threadId === res.threadId)!
    expect(req.prompt).toContain('[BTW CONTEXT]')
    expect(req.prompt).toContain(sessionId)
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
    const { sessionId } = h.sa.openInTerminal({ threadId: 'global' })
    // A REAL spawn went to the daemon, carrying the harness resume ref.
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]).toMatchObject({
      sessionId,
      agentKind: 'claude-code',
      resume: { kind: RESUME_KIND['claude-code'], value: 'h1' },
    })
    const meta = h.registry.listSessions().find((s) => s.sessionId === sessionId)
    expect(meta?.headless).toBeUndefined() // a normal PTY session
    expect(h.registry.sessionStore.getSuperagentThread('global')?.terminalSessionId).toBe(sessionId)
    // One writer: sendTurn refuses while the terminal session is alive.
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'x' })).rejects.toThrow(
      /open in a terminal/,
    )
    // The lock clears lazily once the terminal session is gone.
    h.registry.killSession({ sessionId })
    await expect(h.sa.sendTurn({ threadId: 'global', text: 'x' })).resolves.toBeTruthy()
    expect(h.registry.sessionStore.getSuperagentThread('global')?.terminalSessionId).toBeUndefined()
  })

  it('refuses before a harness session exists and while a turn is running', async () => {
    const h = await harness()
    expect(() => h.sa.openInTerminal({ threadId: 'global' })).toThrow(/no harness session/)
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(() => h.sa.openInTerminal({ threadId: 'global' })).toThrow(/turn is running/)
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
  it('stays live across a restart and rebinds tails via headlessBind (no reattach probe)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const sessionId = h.registry.sessionStore.getSuperagentThread('global')?.podiumSessionId
    // "Restart": a fresh registry over the same store.
    const store = h.registry.sessionStore
    const reborn = new SessionRegistry(store)
    registries.push(reborn)
    const binds: BindReq[] = []
    const reattaches: string[] = []
    reborn.attachDaemon('local', (m) => {
      if (m.type === 'headlessBind') {
        binds.push(m)
        queueMicrotask(() =>
          reborn.onDaemonMessageFrom('local', {
            type: 'headlessBindResult',
            requestId: m.requestId,
            ok: true,
          }),
        )
      }
      if (m.type === 'reattach') reattaches.push(m.sessionId)
    })
    await new Promise((r) => setTimeout(r))
    const meta = reborn.listSessions().find((s) => s.sessionId === sessionId)
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
    patch: { harness?: HarnessAgent; effort?: string },
  ) => {
    const cur = h.registry.sessionStore.getSettings()
    const harness = patch.harness ?? 'claude-code'
    h.registry.sessionStore.setSettings({
      ...cur,
      roles: {
        ...cur.roles,
        superagent: {
          ...cur.roles.superagent,
          accountId: nativeAccountId(harness),
          harness,
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
    expect(h.turnReqs[0]!.agent).toBe('claude-code')

    // User picks a different harness in settings.
    setSuperagentHarness(h, { harness: 'codex' })
    const second = await h.sa.sendTurn({ threadId: 'global', text: 'still there?' })

    const req = h.turnReqs[1]!
    expect(req.agent).toBe('codex') // switched
    expect(req.resumeValue).toBeUndefined() // fresh session, not resuming claude-1
    expect(second.podiumSessionId).not.toBe(first.podiumSessionId) // new headless row
    // The thread is re-bound to the new harness.
    expect(h.registry.sessionStore.getSuperagentThread('global')?.agentKind).toBe('codex')
    expect(h.registry.sessionStore.getSuperagentThread('global')?.harnessSessionId).toBeFalsy()
  })

  it('does not switch when the setting is unchanged (resumes)', async () => {
    const h = await harness()
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    expect(h.turnReqs[1]!.agent).toBe('claude-code')
    expect(h.turnReqs[1]!.resumeValue).toBe('claude-1') // same session
  })

  it('restartThread resets the harness session so the next turn is fresh', async () => {
    const h = await harness()
    const first = await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    h.sa.restartThread({ threadId: 'global' })
    const row = h.registry.sessionStore.getSuperagentThread('global')
    expect(row?.harnessSessionId).toBeFalsy()
    expect(row?.podiumSessionId).toBeFalsy()
    expect(row?.agentKind).toBe('claude-code') // agent kept, only the session reset
    const second = await h.sa.sendTurn({ threadId: 'global', text: 'again' })
    expect(second.podiumSessionId).not.toBe(first.podiumSessionId) // fresh session
    expect(h.turnReqs[1]!.resumeValue).toBeUndefined()
  })

  it('plumbs harnessEffort into the turn request; auto sends none', async () => {
    const h = await harness()
    setSuperagentHarness(h, { harness: 'claude-code', effort: 'high' })
    await h.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(h.turnReqs[0]!.effort).toBe('high')

    const h2 = await harness()
    setSuperagentHarness(h2, { harness: 'claude-code', effort: 'auto' })
    await h2.sa.sendTurn({ threadId: 'global', text: 'hi' })
    expect(h2.turnReqs[0]!.effort).toBeUndefined()
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
