import { describe, expect, it } from 'vitest'
import {
  AgentKind,
  AgentQuotaResultMessage,
  ClientMessage,
  type ControlMessage,
  ConversationSummaryWire,
  type DaemonMessage,
  encode,
  GitRepositoryWire,
  MachineWire,
  parseClientMessage,
  parseControlMessage,
  parseDaemonHandshake,
  parseDaemonHandshakeReply,
  parseDaemonMessage,
  parseServerMessage,
  parseServerMessageLenient,
  ResumeRef,
  ServerMessage,
  SessionMeta,
  SessionStatus,
} from './messages'

describe('shared schemas', () => {
  it('round-trips a SessionMeta (spawn origin)', () => {
    const meta = {
      sessionId: 's1',
      agentKind: 'claude-code' as const,
      title: 'fix the bug',
      cwd: '/home/u/proj',
      status: 'live' as const,
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
      archived: false,
      readAt: null,
      unread: false,
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  // Provenance (issue #60): spawnedBy is optional/additive — the payload above
  // (no spawnedBy, as every pre-#60 server emits) already parses; here the tagged
  // form round-trips too.
  it('round-trips a SessionMeta carrying spawnedBy', () => {
    const meta = {
      sessionId: 's1',
      agentKind: 'claude-code' as const,
      title: 't',
      cwd: '/w',
      status: 'live' as const,
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
      archived: false,
      readAt: null,
      unread: false,
      spawnedBy: 'issue:iss_abc',
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
    expect(SessionMeta.parse(meta).spawnedBy).toBe('issue:iss_abc')
  })

  it('round-trips a SessionMeta (resume origin, exited)', () => {
    const meta = {
      sessionId: 's2',
      agentKind: 'codex' as const,
      title: 'old thread',
      cwd: '/w',
      status: 'exited' as const,
      exitCode: 0,
      controllerId: null,
      geometry: { cols: 100, rows: 30 },
      epoch: 2,
      clientCount: 0,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'resume' as const, conversationId: 'conv-9' },
      archived: true,
      readAt: null,
      unread: false,
      workState: 'done' as const,
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  it('round-trips a SessionMeta (starting, no controller yet)', () => {
    const meta = {
      sessionId: 's3',
      agentKind: 'claude-code' as const,
      title: 'new',
      cwd: '/w',
      status: 'starting' as const,
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
      archived: false,
      readAt: null,
      unread: false,
      name: 'soft keyboard work',
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  // Unread state (issue #124): readAt + unread are additive, defaulted so pre-field
  // cached payloads still validate (readAt → null, unread → false).
  const baseMeta = {
    sessionId: 's_unread',
    agentKind: 'claude-code' as const,
    title: 't',
    cwd: '/w',
    status: 'live' as const,
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' as const },
    archived: false,
  }

  it('SessionMeta defaults readAt=null and unread=false for a pre-field payload', () => {
    const parsed = SessionMeta.parse(baseMeta)
    expect(parsed.readAt).toBeNull()
    expect(parsed.unread).toBe(false)
  })

  it('SessionMeta carries readAt + unread when present', () => {
    const parsed = SessionMeta.parse({
      ...baseMeta,
      readAt: '2026-06-03T01:00:00.000Z',
      unread: true,
    })
    expect(parsed.readAt).toBe('2026-06-03T01:00:00.000Z')
    expect(parsed.unread).toBe(true)
  })

  it('SessionMeta tolerates malformed cached readAt/unread via catch', () => {
    const parsed = SessionMeta.parse({ ...baseMeta, readAt: 123, unread: 'yes' })
    expect(parsed.readAt).toBeNull()
    expect(parsed.unread).toBe(false)
  })

  it('parses AgentKind and ResumeRef', () => {
    expect(AgentKind.parse('codex')).toBe('codex')
    expect(AgentKind.parse('grok')).toBe('grok')
    expect(AgentKind.parse('opencode')).toBe('opencode')
    expect(AgentKind.parse('cursor')).toBe('cursor')
    expect(AgentKind.parse('shell')).toBe('shell')
    expect(ResumeRef.parse({ kind: 'claude-session', value: 'abc' })).toEqual({
      kind: 'claude-session',
      value: 'abc',
    })
  })

  it('round-trips a ConversationSummaryWire with optional fields omitted', () => {
    const min = { id: 'x', agentKind: 'claude-code' as const, providerId: 'claude-code-jsonl' }
    expect(ConversationSummaryWire.parse(min)).toEqual(min)
  })

  it('round-trips ConversationSummaryWire.sizeBytes (the mirror dirty signal)', () => {
    const sized = {
      id: 'x',
      agentKind: 'claude-code' as const,
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-p/x.jsonl',
      sizeBytes: 4096,
    }
    expect(ConversationSummaryWire.parse(sized)).toEqual(sized)
    // Negative / fractional sizes are wire corruption, not evidence.
    expect(() => ConversationSummaryWire.parse({ ...sized, sizeBytes: -1 })).toThrow()
    expect(() => ConversationSummaryWire.parse({ ...sized, sizeBytes: 1.5 })).toThrow()
  })

  it('round-trips a GitRepositoryWire with worktrees', () => {
    const repo = {
      path: '/r',
      kind: 'repository' as const,
      branch: 'main',
      worktrees: [{ path: '/r-wt', branch: 'feat' }],
    }
    expect(GitRepositoryWire.parse(repo)).toEqual(repo)
  })
})

describe('ClientMessage', () => {
  const cases: ClientMessage[] = [
    { type: 'hello', clientId: 'c1', viewport: { cols: 80, rows: 24, dpr: 2 } },
    { type: 'attach', sessionId: 's1' },
    { type: 'detach', sessionId: 's1' },
    { type: 'input', sessionId: 's1', data: 'aGk=' },
    { type: 'resize', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'requestControl', sessionId: 's1' },
    { type: 'redrawRequest', sessionId: 's1' },
    { type: 'ping' },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })
  it('rejects input without sessionId', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'input', data: 'x' }))).toThrow()
  })
  it('rejects resize with non-positive cols', () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 0, rows: 24 })),
    ).toThrow()
  })
})

describe('ServerMessage', () => {
  const geometry = { cols: 80, rows: 24 }
  const sessionMeta = {
    sessionId: 's1',
    agentKind: 'claude-code' as const,
    title: 't',
    cwd: '/w',
    status: 'live' as const,
    controllerId: 'c0',
    geometry,
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' as const },
    archived: false,
    readAt: null,
    unread: false,
  }
  const conversation = {
    id: 'conv-1',
    agentKind: 'codex' as const,
    title: 'Cached discovery',
    projectPath: '/w',
    providerId: 'codex-jsonl',
    resume: { kind: 'codex-thread', value: 'conv-1' },
  }
  const cases: ServerMessage[] = [
    { type: 'welcome', clientId: 'c0' },
    { type: 'attached', sessionId: 's1', controllerId: 'c0', geometry, epoch: 0 },
    { type: 'attached', sessionId: 's1', controllerId: null, geometry, epoch: 0 },
    { type: 'outputFrame', sessionId: 's1', seq: 3, epoch: 1, data: 'eA==' },
    { type: 'controllerChanged', sessionId: 's1', controllerId: 'c1', geometry },
    { type: 'geometry', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'agentExit', sessionId: 's1', code: 0 },
    { type: 'sessionsChanged', sessions: [sessionMeta] },
    { type: 'conversationsChanged', conversations: [conversation], diagnostics: [] },
    { type: 'sessionTitleChanged', sessionId: 's1', title: '✳ rename functionality' },
    {
      type: 'sessionAgentStateChanged',
      sessionId: 's1',
      state: {
        phase: 'errored',
        since: '2026-06-12T10:00:00.000Z',
        openTaskCount: 0,
        error: { class: 'rate_limit', retryable: true },
      },
    },
    { type: 'pong' },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })
})

describe('parseServerMessageLenient (per-element quarantine)', () => {
  const geometry = { cols: 80, rows: 24 }
  const session = (id: string, agentKind: string) => ({
    sessionId: id,
    agentKind,
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry,
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
  })

  it('drops one poisoned session and keeps the rest (the original bug, survivable)', () => {
    const raw = JSON.stringify({
      type: 'sessionsChanged',
      sessions: [session('a', 'claude-code'), session('bad', 'auto'), session('c', 'codex')],
    })
    const { message, dropped } = parseServerMessageLenient(raw)
    expect(dropped).toBe(1)
    expect(message?.type === 'sessionsChanged' && message.sessions.map((s) => s.sessionId)).toEqual(
      ['a', 'c'],
    )
  })

  it('passes a fully valid collection through unchanged (dropped=0)', () => {
    const raw = JSON.stringify({ type: 'sessionsChanged', sessions: [session('a', 'claude-code')] })
    const { message, dropped } = parseServerMessageLenient(raw)
    expect(dropped).toBe(0)
    expect(message?.type === 'sessionsChanged' && message.sessions.length).toBe(1)
  })

  it('parses non-collection messages strictly', () => {
    const { message, dropped } = parseServerMessageLenient(
      JSON.stringify({ type: 'welcome', clientId: 'c0' }),
    )
    expect(dropped).toBe(0)
    expect(message?.type).toBe('welcome')
  })

  it('throws on a structurally malformed frame (not a quarantine case)', () => {
    expect(() => parseServerMessageLenient('{not json')).toThrow()
  })
})

describe('ControlMessage (server -> daemon)', () => {
  const geometry = { cols: 80, rows: 24 }
  const cases: ControlMessage[] = [
    { type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/w', geometry },
    {
      type: 'spawn',
      sessionId: 's2',
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 'id9' },
      geometry,
    },
    {
      type: 'spawn',
      sessionId: 's-grok',
      agentKind: 'grok',
      cwd: '/w',
      resume: { kind: 'grok-session', value: 'g9' },
      geometry,
    },
    {
      type: 'harnessExecRequest',
      requestId: 'hx-grok',
      agent: 'grok',
      prompt: 'summarize this repo',
      cwd: '/w',
    },
    {
      type: 'harnessExecRequest',
      requestId: 'hx-sa',
      agent: 'codex',
      prompt: 'orchestrate',
      mcpConfig: '{"mcpServers":{}}',
      timeoutMs: 600_000,
    },
    { type: 'kill', sessionId: 's1' },
    { type: 'scanRequest', requestId: 'r1' },
    { type: 'scanReposRequest', requestId: 'rr1', roots: ['/home/u/src'] },
    { type: 'input', sessionId: 's1', data: 'aGk=' },
    { type: 'resize', sessionId: 's1', cols: 100, rows: 30 },
    { type: 'redraw', sessionId: 's1' },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })
})

describe('DaemonMessage (daemon -> server)', () => {
  const geometry = { cols: 80, rows: 24 }
  const conversation = {
    id: 'conv-1',
    agentKind: 'grok' as const,
    title: 'Grok discovery',
    projectPath: '/w',
    providerId: 'grok-sessions',
    resume: { kind: 'grok-session', value: 'conv-1' },
  }
  const cases: DaemonMessage[] = [
    { type: 'bind', sessionId: 's1', cmd: 'claude', cwd: '/w', agentKind: 'claude-code', geometry },
    { type: 'bind', sessionId: 's-grok', cmd: 'grok', cwd: '/w', agentKind: 'grok', geometry },
    { type: 'agentFrame', sessionId: 's1', seq: 0, data: 'eA==' },
    { type: 'agentExit', sessionId: 's1', code: 0 },
    { type: 'spawnError', sessionId: 's1', message: 'enoent' },
    { type: 'title', sessionId: 's1', title: '⠹ podium' },
    { type: 'scanResult', requestId: 'r1', conversations: [], diagnostics: [] },
    { type: 'conversationsChanged', conversations: [conversation], diagnostics: [] },
    {
      type: 'scanReposResult',
      requestId: 'rr1',
      repositories: [
        {
          path: '/home/u/src/app',
          kind: 'repository',
          branch: 'main',
          headSha: 'abc',
          worktrees: [{ path: '/home/u/src/app-feat', branch: 'feat', locked: false }],
        },
      ],
      diagnostics: [{ severity: 'warning', path: '/bad', message: 'nope' }],
    },
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})

describe('codec', () => {
  it('throws on malformed JSON', () => {
    expect(() => parseClientMessage('{not json')).toThrow()
  })
  it('throws on unknown type', () => {
    expect(() => parseServerMessage(JSON.stringify({ type: 'nope' }))).toThrow()
  })
})

describe('Layer 3 reattach messages', () => {
  it('SessionStatus includes reconnecting + hibernated', () => {
    expect(SessionStatus.options).toContain('reconnecting')
    expect(SessionStatus.options).toContain('hibernated')
  })

  it('round-trips a reattach control message', () => {
    const msg = {
      type: 'reattach' as const,
      sessionId: 's1',
      durableLabel: 'podium-s1',
      agentKind: 'claude-code' as const,
      cwd: '/p',
      geometry: { cols: 80, rows: 24 },
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a reattachFailed daemon message', () => {
    const msg = { type: 'reattachFailed' as const, sessionId: 's1', reason: 'no tmux session' }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})

describe('host metrics messages', () => {
  const memory = {
    totalBytes: 34_359_738_368,
    availableBytes: 21_474_836_480,
    swapTotalBytes: 8_589_934_592,
    swapFreeBytes: 8_589_934_592,
  }

  it('round-trips a hostMetrics daemon message', () => {
    const msg = {
      type: 'hostMetrics' as const,
      hostname: 'podium-host',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory,
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a hostMetricsChanged server message (empty + populated)', () => {
    const empty = { type: 'hostMetricsChanged' as const, hosts: [] }
    expect(parseServerMessage(encode(empty))).toEqual(empty)
    const msg = {
      type: 'hostMetricsChanged' as const,
      hosts: [{ hostname: 'podium-host', sampledAt: '2026-06-11T00:00:00.000Z', memory }],
    }
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })

  it('rejects negative byte counts', () => {
    expect(() =>
      parseDaemonMessage(
        encode({
          type: 'hostMetrics',
          hostname: 'h',
          sampledAt: '2026-06-11T00:00:00.000Z',
          memory: { ...memory, availableBytes: -1 },
        } as never),
      ),
    ).toThrow()
  })
})

describe('memory breakdown messages', () => {
  it('round-trips a memoryBreakdownRequest control message', () => {
    const msg = {
      type: 'memoryBreakdownRequest' as const,
      requestId: 'mb1',
      roots: ['/src/app', '/src/lib'],
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a memoryBreakdownResult daemon message', () => {
    const msg = {
      type: 'memoryBreakdownResult' as const,
      requestId: 'mb1',
      hostname: 'podium-host',
      sampledAt: '2026-06-11T00:00:00.000Z',
      supported: true,
      memory: { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 },
      agents: [{ sessionId: 's1', bytes: 4, processCount: 3 }],
      projects: [
        {
          root: '/src/app',
          bytes: 2,
          processCount: 2,
          topProcesses: [{ name: 'node', bytes: 2 }],
        },
      ],
      otherBytes: 10,
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips an unsupported (non-Linux) result with empty groups', () => {
    const msg = {
      type: 'memoryBreakdownResult' as const,
      requestId: 'mb2',
      hostname: 'mac',
      sampledAt: '2026-06-11T00:00:00.000Z',
      supported: false,
      memory: { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 },
      agents: [],
      projects: [],
      otherBytes: 16,
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})

describe('session draft messages', () => {
  it('parses setSessionDraft (client) and sessionDraftChanged (server)', () => {
    expect(
      ClientMessage.parse({ type: 'setSessionDraft', sessionId: 's', text: 'hi' }),
    ).toMatchObject({
      type: 'setSessionDraft',
      text: 'hi',
    })
    expect(
      ServerMessage.parse({ type: 'sessionDraftChanged', sessionId: 's', text: 'hi' }),
    ).toMatchObject({
      type: 'sessionDraftChanged',
      text: 'hi',
    })
  })
})

describe('multi-machine protocol', () => {
  it('parses a hello handshake frame', () => {
    const m = parseDaemonHandshake(
      JSON.stringify({ type: 'hello', machineId: 'm1', token: 't', hostname: 'box' }),
    )
    expect(m.type).toBe('hello')
  })
  it('parses a pair frame and the paired reply', () => {
    expect(
      parseDaemonHandshake(
        JSON.stringify({ type: 'pair', code: 'AAAA-BBBB', machineId: 'm1', hostname: 'box' }),
      ).type,
    ).toBe('pair')
    expect(
      parseDaemonHandshakeReply(
        JSON.stringify({ type: 'paired', token: 't', machineId: 'm1', name: 'box' }),
      ).type,
    ).toBe('paired')
  })
  it('accepts a MachineWire and rejects an incomplete SessionMeta', () => {
    // machineId/machineName are OPTIONAL on SessionMeta; this still throws on the
    // other required fields (sessionId, agentKind, …) being absent.
    expect(() => SessionMeta.parse({ machineId: 'm1' })).toThrow()
    expect(
      MachineWire.parse({ id: 'm1', name: 'box', hostname: 'box', online: true, lastSeenAt: 'x' })
        .id,
    ).toBe('m1')
  })
})

describe('image upload messages', () => {
  it('round-trips an imageUploadRequest control message', () => {
    const msg = {
      type: 'imageUploadRequest' as const,
      requestId: 'iu1',
      sessionId: 's1',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      dataBase64: 'aGVsbG8=',
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips an imageUploadResult daemon message', () => {
    const msg = {
      type: 'imageUploadResult' as const,
      requestId: 'iu1',
      path: '/home/u/.podium/uploads/s1/abc.png',
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('rejects imageUploadRequest missing mimeType', () => {
    expect(() =>
      parseControlMessage(
        JSON.stringify({
          type: 'imageUploadRequest',
          requestId: 'r1',
          sessionId: 's1',
          filename: 'f.png',
          dataBase64: 'x',
        }),
      ),
    ).toThrow()
  })
})

describe('agent runtime state', () => {
  const state = {
    phase: 'errored',
    since: '2026-06-12T10:00:00.000Z',
    openTaskCount: 2,
    error: { class: 'rate_limit', retryable: true },
  }

  it('round-trips an agentState daemon message', () => {
    const msg = { type: 'agentState', sessionId: 's1', state }
    expect(parseDaemonMessage(encode(msg as never))).toEqual(msg)
  })

  it('rejects an unknown phase', () => {
    const bad = { type: 'agentState', sessionId: 's1', state: { ...state, phase: 'napping' } }
    expect(() => parseDaemonMessage(JSON.stringify(bad))).toThrow()
  })

  it('SessionMeta accepts an optional agentState', () => {
    const meta = SessionMeta.parse({
      sessionId: 's1',
      agentKind: 'claude-code',
      title: 't',
      cwd: '/tmp',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-06-12T10:00:00.000Z',
      lastActiveAt: '2026-06-12T10:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
      agentState: {
        phase: 'idle',
        since: '2026-06-12T10:00:00.000Z',
        openTaskCount: 0,
        idle: { kind: 'question', summary: 'Should I migrate?' },
      },
    })
    expect(meta.agentState?.phase).toBe('idle')
  })

  it('SessionMeta carries an optional, nullable snoozedUntil', () => {
    const base = {
      sessionId: 's1',
      agentKind: 'claude-code',
      title: 't',
      cwd: '/w',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
    } as const
    expect(SessionMeta.parse(base).snoozedUntil).toBeUndefined()
    expect(SessionMeta.parse({ ...base, snoozedUntil: null }).snoozedUntil).toBeNull()
    expect(
      SessionMeta.parse({ ...base, snoozedUntil: '2026-06-19T06:00:00.000Z' }).snoozedUntil,
    ).toBe('2026-06-19T06:00:00.000Z')
  })

  it('SessionMeta carries the additive upstream-mirror flags (node⇄hub sync)', () => {
    const base = {
      sessionId: 's1',
      agentKind: 'shell',
      title: 't',
      cwd: '/w',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-07-01T00:00:00.000Z',
      lastActiveAt: '2026-07-01T00:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
    } as const
    // Additive: absent = a local session (older peers keep parsing).
    const local = SessionMeta.parse(base)
    expect(local.viaHub).toBeUndefined()
    expect(local.upstreamStale).toBeUndefined()
    const mirrored = SessionMeta.parse({ ...base, viaHub: true, upstreamStale: true })
    expect(mirrored.viaHub).toBe(true)
    expect(mirrored.upstreamStale).toBe(true)
    expect(() => SessionMeta.parse({ ...base, viaHub: 'yes' })).toThrow()
  })
})

describe('agent quota messages', () => {
  it('round-trips an agentQuotaRequest through the control union', () => {
    const msg = { type: 'agentQuotaRequest' as const, requestId: 'aq1' }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips an agentQuotaResult over encode/decode', () => {
    const msg = {
      type: 'agentQuotaResult' as const,
      requestId: 'aq1',
      hostname: 'box',
      agents: [
        {
          agent: 'claude-code' as const,
          status: 'ok' as const,
          windows: [
            {
              key: '5h' as const,
              label: '5-hour',
              usedPercent: 42.5,
              resetsAt: '2026-06-19T20:00:00.000Z',
              windowMinutes: 300,
            },
            {
              key: 'weekly' as const,
              label: 'Weekly',
              usedPercent: 7,
              resetsAt: '2026-06-24T00:00:00.000Z',
              windowMinutes: 10080,
            },
          ],
          fetchedAt: '2026-06-19T18:00:00.000Z',
        },
      ],
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
    expect(AgentQuotaResultMessage.parse(msg)).toEqual(msg)
  })
})

describe('output-scheduling protocol', () => {
  it('round-trips agentFrameBatch (daemon→server)', () => {
    // Per-field `as const` (not whole-object) keeps `frames` a mutable string[] so it
    // matches encode()'s AnyMessage param — whole-object `as const` makes it readonly.
    const m = { type: 'agentFrameBatch' as const, sessionId: 's1', frames: ['YQ==', 'Yg=='] }
    expect(parseDaemonMessage(encode(m))).toEqual(m)
  })
  it('round-trips viewState (client→server), focused nullable', () => {
    const m = { type: 'viewState' as const, visible: ['s1', 's2'], focused: 's1' }
    expect(parseClientMessage(encode(m))).toEqual(m)
    const m2 = { type: 'viewState' as const, visible: [] as string[], focused: null }
    expect(parseClientMessage(encode(m2))).toEqual(m2)
  })
  it('round-trips viewState with an optional modes map (rendered native/chat)', () => {
    const m = {
      type: 'viewState' as const,
      visible: ['s1', 's2'],
      focused: 's1',
      modes: { s1: 'native' as const, s2: 'chat' as const },
    }
    expect(parseClientMessage(encode(m))).toEqual(m)
  })
  it('viewState without modes still parses (backward compatible old clients)', () => {
    const m = { type: 'viewState' as const, visible: ['s1'], focused: 's1' }
    const parsed = parseClientMessage(encode(m))
    expect(parsed).toEqual(m)
    expect((parsed as { modes?: unknown }).modes).toBeUndefined()
  })
  it('round-trips sessionPriority (server→daemon)', () => {
    const m = { type: 'sessionPriority' as const, sessionId: 's1', priority: 0 }
    expect(parseControlMessage(encode(m))).toEqual(m)
  })
  it('rejects out-of-range / non-int sessionPriority', () => {
    for (const p of [-1, 4, 1.5]) {
      expect(() =>
        parseControlMessage(
          encode({ type: 'sessionPriority', sessionId: 's', priority: p } as never),
        ),
      ).toThrow()
    }
  })
})

describe('issue relay messages', () => {
  it('round-trips an issueRelayRequest (daemon→server)', () => {
    const m = parseDaemonMessage(
      JSON.stringify({
        type: 'issueRelayRequest',
        requestId: 'ir0',
        sessionId: 's1',
        router: 'issues',
        proc: 'ready',
        input: { repoPath: '/r' },
      }),
    )
    expect(m.type).toBe('issueRelayRequest')
  })

  it('round-trips an issueRelayResult (server→daemon)', () => {
    const m = parseControlMessage(
      JSON.stringify({ type: 'issueRelayResult', requestId: 'ir0', ok: true, result: 'x' }),
    )
    expect(m.type).toBe('issueRelayResult')
  })
})

describe('headless harness frames (concierge unification, Phase A)', () => {
  it('round-trips a headlessTurnRequest through the ControlMessage codec', () => {
    const msg: ControlMessage = {
      type: 'headlessTurnRequest',
      requestId: 'ht1',
      sessionId: 's1',
      threadId: 'concierge',
      agent: 'claude-code',
      model: 'opus',
      effort: 'low',
      cwd: '/repo',
      prompt: 'hello',
      systemPrompt: 'be the orchestrator',
      mcpConfig: '{"mcpServers":{}}',
      allowedTools: ['Read'],
      permissionMode: 'bypassPermissions',
      sessionUuid: '11111111-2222-3333-4444-555555555555',
      timeoutMs: 600_000,
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a minimal resume-turn request (only required fields + resumeValue)', () => {
    const msg: ControlMessage = {
      type: 'headlessTurnRequest',
      requestId: 'ht2',
      sessionId: 's1',
      threadId: 'btw_x',
      agent: 'codex',
      cwd: '/repo',
      prompt: 'continue',
      resumeValue: '019f0000-aaaa-bbbb-cccc-000000000000',
    }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips headlessInterrupt and headlessBind', () => {
    const interrupt: ControlMessage = { type: 'headlessInterrupt', requestId: 'hi1', sessionId: 's1' }
    expect(parseControlMessage(encode(interrupt))).toEqual(interrupt)
    const bind: ControlMessage = {
      type: 'headlessBind',
      requestId: 'hb1',
      sessionId: 's1',
      agentKind: 'grok',
      cwd: '/repo',
      resumeValue: 'abc',
    }
    expect(parseControlMessage(encode(bind))).toEqual(bind)
  })

  it('round-trips headlessTurnEvent/Result/BindResult through the DaemonMessage codec', () => {
    const partial: DaemonMessage = {
      type: 'headlessTurnEvent',
      requestId: 'ht1',
      sessionId: 's1',
      event: { kind: 'partial-text', text: 'Hel', itemHint: 'u1' },
    }
    expect(parseDaemonMessage(encode(partial))).toEqual(partial)
    const status: DaemonMessage = {
      type: 'headlessTurnEvent',
      requestId: 'ht1',
      sessionId: 's1',
      event: { kind: 'status', status: 'tool', label: 'Bash' },
    }
    expect(parseDaemonMessage(encode(status))).toEqual(status)
    const result: DaemonMessage = {
      type: 'headlessTurnResult',
      requestId: 'ht1',
      ok: true,
      harnessSessionId: 'abc',
      output: 'done',
    }
    expect(parseDaemonMessage(encode(result))).toEqual(result)
    const bindResult: DaemonMessage = {
      type: 'headlessBindResult',
      requestId: 'hb1',
      ok: false,
      error: 'no such kind',
    }
    expect(parseDaemonMessage(encode(bindResult))).toEqual(bindResult)
  })

  it('rejects a turn event with an unknown kind', () => {
    expect(() =>
      parseDaemonMessage(
        encode({
          type: 'headlessTurnEvent',
          requestId: 'x',
          sessionId: 's',
          event: { kind: 'bogus' },
        } as unknown as DaemonMessage),
      ),
    ).toThrow()
  })

  it('round-trips headlessActivity (turn boundaries) through the ServerMessage codec', () => {
    const start: ServerMessage = {
      type: 'headlessActivity',
      sessionId: 's1',
      event: { kind: 'turn-start' },
    }
    expect(parseServerMessage(encode(start))).toEqual(start)
    const end: ServerMessage = {
      type: 'headlessActivity',
      sessionId: 's1',
      event: { kind: 'turn-end', error: 'boom' },
    }
    expect(parseServerMessage(encode(end))).toEqual(end)
    const text: ServerMessage = {
      type: 'headlessActivity',
      sessionId: 's1',
      event: { kind: 'partial-text', text: 'hi' },
    }
    expect(parseServerMessage(encode(text))).toEqual(text)
  })
})
