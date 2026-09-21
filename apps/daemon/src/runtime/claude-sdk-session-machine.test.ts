/**
 * CLAUDE SDK SESSIONS THROUGH THE MACHINE ROOT.
 *
 * The session adapter itself is pinned family-side
 * (families/claude-sdk/session.test.ts); what stays here is the machine
 * composition: a process-gone resume routes through the machine runtime and
 * publishes the bind exactly once.
 */
import { pageHistory } from '@podium/harness/driver/host'
import type { ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeSdkSessionRuntime } from '@podium/harness/driver/host'
import { createDaemonMachineRuntime } from './machine-runtime'
import type { TerminalRuntimeHost } from './terminal-driver'

const SESSION_ID = 'claude-adapter-session' as SessionId
const RESUME: ResumeRef = { kind: 'claude-session', value: 'claude-native-thread' }

const WITNESS: TranscriptItem[] = [
  {
    id: 'witness-user',
    role: 'user',
    text: 'before the daemon restart',
    ts: '2026-08-27T00:00:00.000Z',
  },
  {
    id: 'witness-assistant',
    role: 'assistant',
    text: 'the earlier answer',
    ts: '2026-08-27T00:00:01.000Z',
  },
]

function host(reads: Array<{ resumeValue: string; limit: number }>): TerminalRuntimeHost {
  return {
    readHistory: async (session: { resume?: { value?: string } }, range: { limit: number }) => {
      reads.push({ resumeValue: session.resume?.value ?? '', limit: range.limit })
      return pageHistory(WITNESS, session.resume?.value ?? '', range)
    },
  } as unknown as TerminalRuntimeHost
}

function serverRuntime(id: string, harness: string) {
  return {
    driver: {
      id,
      harness,
      family: 'server',
      capabilities: () => ({ placement: 'dedicated' as const }),
    },
    handleFor: () => undefined,
    bindings: () => [],
    journalEntry: () => undefined,
    clearJournal: vi.fn(),
    describe: id,
    launch: vi.fn(async () => {}),
    adoptFromJournal: vi.fn(async () => undefined),
    reportOomKill: vi.fn(),
    dispose: vi.fn(),
  }
}

describe('Claude SDK sessions through the machine root', () => {
  it('routes process-gone resume through the machine root and publishes once', async () => {
    const sent: DaemonMessage[] = []
    const claude = createClaudeSdkSessionRuntime({
      send: (message) => sent.push(message),
      emitBind: (bind) => {
        sent.push({ type: 'bind', ...bind })
      },
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: () => () => {},
      facts: {
        harnessKind: 'claude-code',
        command: 'claude',
        stripEnv: [],
        scopeToken: 'cl',
        journalNamespace: 'claude-engines',
        attachKind: 'claude-code',
      },
      engine: {
        journal: { read: () => undefined, write: () => {}, clear: () => {} },
        startTurn: () => {
          throw new Error('no engine turn in this test')
        },
        stopEngine: async () => {},
        releaseEngines: () => {},
      },
      transcript: {
        readHistory: host([]).readHistory,
        archiveTranscript: async () => ({ path: '/tmp/archive.jsonl' }),
        readFileBytes: async () => new Uint8Array(),
      },
    })
    const terminal = {
      driverFor: vi.fn(),
      handleFor: () => undefined,
      bindings: () => [],
      observe: vi.fn(),
      onHookPayload: vi.fn(),
      register: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    }
    const machine = createDaemonMachineRuntime({
      terminal,
      claude,
      servers: [
        serverRuntime('opencode-server', 'opencode'),
        serverRuntime('opencode2-server', 'opencode'),
        serverRuntime('codex-app-server', 'codex'),
        serverRuntime('grok-acp', 'grok'),
      ],
      headless: {
        driverFor: () => undefined,
        handleFor: () => undefined,
        bindings: () => [],
      },
      inventory: async () => ({ os: 'linux', arch: 'x64', agents: [], tools: [] }),
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])

    const handle = await machine.resume(
      RESUME,
      {
        harness: 'claude-code',
        selection: {
          auth: 'unknown',
          platform: 'linux',
          available: ['claude-sdk'],
          preference: 'claude-sdk',
          role: 'interactive',
        },
        workdir: '/project',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      },
      SESSION_ID,
    )

    expect(handle.binding).toMatchObject({
      sessionId: SESSION_ID,
      driver: 'claude-sdk',
      resume: RESUME,
    })
    const binds = sent.filter((message) => message.type === 'bind')
    const states = sent.filter((message) => message.type === 'agentState')
    const refs = sent.filter((message) => message.type === 'sessionResumeRef')
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatchObject({
      sessionId: SESSION_ID,
      driverId: 'claude-sdk',
    })
    expect(states.length).toBeGreaterThanOrEqual(1)
    expect(refs).toEqual([
      {
        type: 'sessionResumeRef',
        sessionId: SESSION_ID,
        resume: RESUME,
        confidence: 'exact',
      },
    ])
    machine.dispose()
  })
})
