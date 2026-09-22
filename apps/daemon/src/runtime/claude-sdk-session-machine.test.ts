/**
 * CLAUDE SDK SESSIONS THROUGH THE MACHINE ROOT.
 *
 * The session adapter itself is pinned family-side
 * (families/claude-sdk/session.test.ts); what stays here is the machine
 * composition: a process-gone resume routes through the machine runtime and
 * publishes the bind exactly once, and — since the engine joined the server
 * family (POD-4612) — a journalled survivor rejoins through the daemon's one
 * generic server reattach arm, which also refuses a row naming a different
 * conversation.
 */
import {
  type ClaudeEngineJournalEntry,
  claudeEngineProcessKey,
  pageHistory,
} from '@podium/harness/driver/host'
import type { ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeSdkSessionRuntime } from '@podium/harness/driver/host'
import type { DaemonContext } from '../control/context'
import { sessionHandlers } from '../control/session'
import { createDaemonMachineRuntime } from './machine-runtime'
import type { TerminalRuntimeHost } from './terminal-driver'
import { driverSlotsOver } from '../session/driver-slots.js'
import { testSessions } from '../session/testing.js'

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

const FACTS = {
  harnessKind: 'claude-code',
  command: 'claude',
  stripEnv: [],
  scopeToken: 'cl',
  journalNamespace: 'claude-engines',
  attachKind: 'claude-code',
} as const

/** The real Claude session runtime behind the real machine root, in the
 *  server list exactly where host-runtime puts it. */
function claudeWorld(journalled?: ClaudeEngineJournalEntry) {
  const sent: DaemonMessage[] = []
  const journal = new Map<string, ClaudeEngineJournalEntry>()
  if (journalled) journal.set(journalled.sessionId, journalled)
  const cleared: string[] = []
  // ONE session registry for the family's driver slots and the daemon
  // context, as in production: the handle lives on the session entry.
  const sessions = testSessions()
  const claude = createClaudeSdkSessionRuntime({
    driverSlots: driverSlotsOver(sessions),
    send: (message: DaemonMessage) => sent.push(message),
    emitBind: (bind: object) => {
      sent.push({ type: 'bind', ...bind } as DaemonMessage)
    },
    sessionReady: () => {},
    traceRuntimeEvent: () => {},
    startMailContinuation: () => () => {},
    facts: FACTS,
    engine: {
      journal: {
        read: (sessionId: SessionId) => journal.get(sessionId),
        write: (entry: ClaudeEngineJournalEntry) => journal.set(entry.sessionId, entry),
        clear: (sessionId: SessionId) => {
          cleared.push(sessionId)
          journal.delete(sessionId)
        },
      },
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
  } as unknown as Parameters<typeof createClaudeSdkSessionRuntime>[0])
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
    servers: [
      serverRuntime('opencode-server', 'opencode'),
      serverRuntime('opencode2-server', 'opencode'),
      serverRuntime('codex-app-server', 'codex'),
      serverRuntime('grok-acp', 'grok'),
      claude,
    ],
    headless: {
      driverFor: () => undefined,
      handleFor: () => undefined,
      bindings: () => [],
    },
    inventory: async () => ({ os: 'linux', arch: 'x64', agents: [], tools: [] }),
  } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
  return { sent, machine, journal, cleared, sessions }
}

describe('Claude SDK sessions through the machine root', () => {
  it('routes process-gone resume through the machine root and publishes once', async () => {
    const { sent, machine } = claudeWorld()

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

/**
 * THE TWO BEHAVIOURS THE BESPOKE ARM CARRIED, NOW THE GENERIC ARM'S (POD-4612).
 *
 * The deleted bespoke Claude adopt/resume arm re-adopted a surviving
 * Claude session and refused a reattach whose resume ref did not match the
 * survivor. Both now go through `adoptServerDriverSession` — the arm codex,
 * opencode and grok take — driven here end to end: the daemon's reattach
 * handler, the real machine root, the real Claude session runtime, and a
 * journal written the way the engine host writes it after a daemon restart.
 */
describe('a surviving Claude engine rejoins through the generic server arm', () => {
  const OTHER: ResumeRef = { kind: 'claude-session', value: 'some-other-conversation' }
  const JOURNAL: ClaudeEngineJournalEntry = {
    sessionId: SESSION_ID,
    claudeSessionId: RESUME.value,
    workdir: '/project',
    process: { key: claudeEngineProcessKey(FACTS, SESSION_ID), pid: 4242 },
    bindingVersion: 1,
  }

  function reattach(world: ReturnType<typeof claudeWorld>, resume: ResumeRef): void {
    const ctx = {
      send: (message: DaemonMessage) => world.sent.push(message),
      machineId: 'claude-machine-test',
      sessions: world.sessions,
      sessionBinding: {
        transition: vi.fn(async () => ({
          status: 'applied',
          binding: { transitionHistory: [] },
        })),
      },
      agentRuntime: world.machine,
      serverReapIo: {
        pidAlive: () => false,
        signal: vi.fn(),
        pidInUnit: () => false,
        probeOpencode: async () => false,
        canScope: async () => false,
        runSystemctl: vi.fn(async () => {}),
        sleep: async () => {},
      },
    } as unknown as DaemonContext
    sessionHandlers.reattach(ctx, {
      type: 'reattach',
      sessionId: SESSION_ID,
      durableLabel: `podium-${SESSION_ID}`,
      agentKind: 'claude-code',
      cwd: '/project',
      lastKnownGeometry: { cols: 80, rows: 24 },
      resume,
      requestedDriverId: 'claude-sdk',
      binding: {
        transitionId: `reattach:${SESSION_ID}`,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'system' },
        adopt: { ownerUserId: 'user:owner' },
      },
    } as never)
  }

  const answered = (world: ReturnType<typeof claudeWorld>) =>
    vi.waitFor(() =>
      expect(
        world.sent.some((message) => message.type === 'bind' || message.type === 'reattachFailed'),
      ).toBe(true),
    )

  it('re-adopts the journalled engine as a server-family session', async () => {
    const world = claudeWorld(JOURNAL)
    reattach(world, RESUME)
    await answered(world)

    expect(world.sent.filter((message) => message.type === 'reattachFailed')).toEqual([])
    expect(world.sent.find((message) => message.type === 'bind')).toMatchObject({
      sessionId: SESSION_ID,
      cwd: '/project',
      driverId: 'claude-sdk',
      attachKinds: [],
    })
    expect(world.machine.handleFor(SESSION_ID)?.binding).toMatchObject({
      sessionId: SESSION_ID,
      driver: 'claude-sdk',
      family: 'server',
      resume: RESUME,
    })
    expect(world.cleared).toEqual([])
    world.machine.dispose()
  })

  it('refuses a reattach naming a different conversation, adopting and reaping nothing', async () => {
    const world = claudeWorld(JOURNAL)
    reattach(world, OTHER)
    await answered(world)

    const failed = world.sent.filter((message) => message.type === 'reattachFailed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      sessionId: SESSION_ID,
      reason: expect.stringContaining('different conversation'),
    })
    expect(world.sent.some((message) => message.type === 'bind')).toBe(false)
    // Nothing adopted, and the survivor's journal is untouched: the REQUEST
    // was wrong, not the engine.
    expect(world.machine.handleFor(SESSION_ID)).toBeUndefined()
    expect(world.journal.has(SESSION_ID)).toBe(true)
    expect(world.cleared).toEqual([])
    world.machine.dispose()
  })
})
