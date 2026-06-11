import { describe, expect, it } from 'vitest'
import {
  AgentKind,
  type ClientMessage,
  type ControlMessage,
  ConversationSummaryWire,
  type DaemonMessage,
  encode,
  GitRepositoryWire,
  parseClientMessage,
  parseControlMessage,
  parseDaemonMessage,
  parseServerMessage,
  ResumeRef,
  type ServerMessage,
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
      origin: { kind: 'spawn' as const },
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
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
      origin: { kind: 'resume' as const, conversationId: 'conv-9' },
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
      origin: { kind: 'spawn' as const },
    }
    expect(SessionMeta.parse(meta)).toEqual(meta)
  })

  it('parses AgentKind and ResumeRef', () => {
    expect(AgentKind.parse('codex')).toBe('codex')
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
    origin: { kind: 'spawn' as const },
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
  ]
  it.each(cases)('round-trips %j', (msg) => {
    expect(parseServerMessage(encode(msg))).toEqual(msg)
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
    agentKind: 'codex' as const,
    title: 'Cached discovery',
    projectPath: '/w',
    providerId: 'codex-jsonl',
    resume: { kind: 'codex-thread', value: 'conv-1' },
  }
  const cases: DaemonMessage[] = [
    { type: 'bind', sessionId: 's1', cmd: 'claude', cwd: '/w', agentKind: 'claude-code', geometry },
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
