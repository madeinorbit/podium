// The stream engine under supervision, hermetically: spawn, adopt, journal,
// stop and kill — over fake host attachments, no daemon, no CLI.

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@podium/model'
import type {
  EngineAttachment,
  EngineSpawnRequest,
  EngineSupervisor,
} from '../engine-supervision.js'
import { EngineBindUnrecoverable } from '../engine-supervision.js'
import {
  ClaudeEngineLeaseRefused,
  createClaudeEngineHost,
  type ClaudeEngineHostDeps,
  type ClaudeEngineJournal,
} from './engine-host.js'
import { claudeEngineFacts } from './engine-facts.js'
import { manifestFor } from '../../../registry.js'
import type { ClaudeSdkTurnHandle } from './runtime.js'

const SESSION_ID = 'claude-engine-session' as SessionId

const FACTS = claudeEngineFacts({
  kind: manifestFor('claude-code')!.kind,
  inventory: manifestFor('claude-code')!.inventory,
})

function fakeAttachment(opts: { lease?: boolean; childPid?: number } = {}): EngineAttachment & {
  writes: string[]
  signals: number[]
  disposed: boolean
  emitStdout(text: string): void
  exit(code: number, signal: number): void
} {
  const writes: string[] = []
  const signals: number[] = []
  const dataCbs = new Set<(seq: bigint, data: Buffer) => void>()
  const exitCbs = new Set<(code: number, signal: number) => void>()
  const attachment = {
    writes,
    signals,
    disposed: false,
    ready: Promise.resolve({
      lease: opts.lease ?? true,
      ...(opts.childPid !== undefined ? { childPid: opts.childPid } : {}),
    }),
    connection: {
      onData: (cb: (seq: bigint, data: Buffer) => void) => {
        dataCbs.add(cb)
        return () => dataCbs.delete(cb)
      },
      onExit: (cb: (code: number, signal: number) => void) => {
        exitCbs.add(cb)
        return () => exitCbs.delete(cb)
      },
      signal: (signum: number) => {
        signals.push(signum)
      },
      write: async (data: Uint8Array) => {
        writes.push(Buffer.from(data).toString('utf8'))
        return data.byteLength
      },
    },
    dispose: () => {
      attachment.disposed = true
    },
    emitStdout: (text: string) => {
      for (const cb of [...dataCbs]) cb(0n, Buffer.from(text))
    },
    exit: (code: number, signal: number) => {
      for (const cb of [...exitCbs]) cb(code, signal)
    },
  }
  return attachment
}

function fakeSupervision(hooks: {
  has?: boolean
  attach?: ReturnType<typeof fakeAttachment>
  spawn?: ReturnType<typeof fakeAttachment>
  killed?: string[]
}): { supervision: EngineSupervisor; spawned: EngineSpawnRequest[] } {
  const spawned: EngineSpawnRequest[] = []
  return {
    spawned,
    supervision: {
      spawnHeadless: async (req) => {
        spawned.push(req)
        if (!hooks.spawn) throw new Error('unexpected spawnHeadless')
        return hooks.spawn
      },
      attachHeadless: async () => {
        if (!hooks.attach) throw new Error('unexpected attachHeadless')
        return hooks.attach
      },
      has: async () => hooks.has ?? false,
      kill: async (label) => {
        hooks.killed?.push(label)
      },
      scopeUnitFor: () => undefined,
    },
  }
}

function journalStore(): ClaudeEngineJournal & { entries: Map<SessionId, { sessionId: SessionId; claudeSessionId: string; workdir: string; process: { key: string }; bindingVersion: number } & Record<string, unknown>> } {
  const entries = new Map()
  return {
    entries,
    read: (sessionId: SessionId) => entries.get(sessionId),
    write: (entry) => {
      entries.set(entry.sessionId, entry)
    },
    clear: (sessionId: SessionId) => {
      entries.delete(sessionId)
    },
  }
}

function hostDeps(
  supervision: EngineSupervisor,
  journal: ClaudeEngineJournal,
  extra: Partial<ClaudeEngineHostDeps> = {},
): ClaudeEngineHostDeps {
  return {
    facts: FACTS,
    supervision,
    journal,
    buildEnv: ({ sessionEnv }) => ({ ...(sessionEnv ?? {}) }),
    gracefulExitMs: 50,
    homeDir: '/state/agent-home',
    executablePath: '/bin/claude',
    ...extra,
  }
}

function turnInput(text = 'hello', resumeValue = 'resume-1', fresh = true) {
  return {
    sessionId: SESSION_ID,
    spec: {
      workdir: '/project',
      model: {},
      instructions: { supported: false as const, reason: 'fixture' },
      mcpServers: { supported: false as const, reason: 'fixture' },
    },
    turn: { text },
    resumeValue,
    newConversation: fresh,
    onPartialText: () => {},
    onPermission: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  } as unknown as Parameters<ReturnType<typeof createClaudeEngineHost>['startTurn']>[0]
}

const frame = (value: unknown): string => JSON.stringify(value)

/** Drive the stub CLI side: answer initialize, report a session, end a turn. */
function answerHandshake(
  attachment: ReturnType<typeof fakeAttachment>,
  sessionId = 'claude-native-1',
): void {
  const init = attachment.writes
    .map((line) => JSON.parse(line))
    .find((msg) => msg.type === 'control_request' && msg.request?.subtype === 'initialize')
  expect(init).toBeDefined()
  attachment.emitStdout(
    `${frame({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: {} } })}\n`,
  )
  attachment.emitStdout(`${frame({ type: 'system', subtype: 'init', session_id: sessionId })}\n`)
}

function endTurn(attachment: ReturnType<typeof fakeAttachment>, output = 'answered'): void {
  attachment.emitStdout(`${frame({ type: 'result', subtype: 'success', result: output })}\n`)
}

describe('the claude stream engine host', () => {
  it('spawns the engine under the host and journals the harness session id', async () => {
    const attachment = fakeAttachment({ childPid: 4242 })
    const { supervision, spawned } = fakeSupervision({ spawn: attachment })
    const journal = journalStore()
    const host = createClaudeEngineHost(hostDeps(supervision, journal))

    const handle = host.startTurn(turnInput())
    // The spawn raced the test's next line; the handshake answer waits for it.
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    expect(spawned[0]).toMatchObject({
      label: 'podium-cl-claude-engine-session',
      cmd: '/bin/claude',
      cwd: '/project',
    })
    expect(spawned[0]?.args).toContain('--input-format')
    expect(spawned[0]?.args).toContain('--session-id')
    expect(spawned[0]?.env).toMatchObject({
      HOME: '/state/agent-home',
      CLAUDE_CONFIG_DIR: '/state/agent-home/.claude',
    })
    answerHandshake(attachment, 'claude-native-1')
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).some((msg) => msg.type === 'user'),
      ).toBe(true),
    )
    endTurn(attachment)
    await expect(handle.done).resolves.toMatchObject({
      resumeValue: 'claude-native-1',
      output: 'answered',
    })
    const entry = journal.read(SESSION_ID)
    expect(entry).toMatchObject({
      sessionId: SESSION_ID,
      claudeSessionId: 'claude-native-1',
      workdir: '/project',
      process: { key: 'podium-cl-claude-engine-session', pid: 4242 },
    })
  })

  it('reuses the held engine for the next turn', async () => {
    const attachment = fakeAttachment({ childPid: 4242 })
    const { supervision, spawned } = fakeSupervision({ spawn: attachment })
    const host = createClaudeEngineHost(hostDeps(supervision, journalStore()))

    const first = host.startTurn(turnInput('one', 'resume-1', true))
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    answerHandshake(attachment, 'claude-native-1')
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).some((msg) => msg.type === 'user'),
      ).toBe(true),
    )
    endTurn(attachment, 'first')
    await expect(first.done).resolves.toMatchObject({ output: 'first' })

    const second = host.startTurn(turnInput('two', 'claude-native-1', false))
    // The second turn binds asynchronously (even to a held engine); its
    // result can only complete a turn the engine has received.
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).filter((msg) => msg.type === 'user'),
      ).toHaveLength(2),
    )
    endTurn(attachment, 'second')
    await expect(second.done).resolves.toMatchObject({
      resumeValue: 'claude-native-1',
      output: 'second',
    })
    // One engine, two turns — and the second turn carried no resume dance.
    expect(spawned).toHaveLength(1)
    const users = attachment.writes.map((line) => JSON.parse(line)).filter((msg) => msg.type === 'user')
    expect(users).toHaveLength(2)
  })

  it('adopts the surviving engine after a restart and completes the turn on it', async () => {
    const attachment = fakeAttachment({ childPid: 9999 })
    const { supervision, spawned } = fakeSupervision({ has: true, attach: attachment })
    const journal = journalStore()
    const host = createClaudeEngineHost(hostDeps(supervision, journal))

    const handle = host.startTurn(turnInput('survive this', 'resume-1', false))
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).some(
          (msg) => msg.type === 'control_request' && msg.request?.subtype === 'initialize',
        ),
      ).toBe(true),
    )
    // Adopted, not spawned: the child predates this generation.
    expect(spawned).toHaveLength(0)
    // The survivor reports its own session; the turn sent after adopt
    // completes on it. The user line goes out asynchronously once the fresh
    // handshake is answered — the completion must wait for it.
    answerHandshake(attachment, 'claude-native-1')
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).some((msg) => msg.type === 'user'),
      ).toBe(true),
    )
    endTurn(attachment, 'survived')
    await expect(handle.done).resolves.toMatchObject({
      resumeValue: 'claude-native-1',
      output: 'survived',
    })
    expect(journal.read(SESSION_ID)?.process).toMatchObject({
      key: 'podium-cl-claude-engine-session',
      pid: 9999,
    })
  })

  it('refuses loudly when another daemon holds the writer lease', async () => {
    const attachment = fakeAttachment({ lease: false })
    const { supervision } = fakeSupervision({ has: true, attach: attachment })
    const host = createClaudeEngineHost(hostDeps(supervision, journalStore()))
    const handle = host.startTurn(turnInput())
    await expect(handle.done).rejects.toBeInstanceOf(ClaudeEngineLeaseRefused)
  })

  it('reaps a stillborn engine and reports the bind failure', async () => {
    const attachment = fakeAttachment({ childPid: 1111 })
    const killed: string[] = []
    const { supervision } = fakeSupervision({ spawn: attachment, killed })
    const journal = journalStore()
    const host = createClaudeEngineHost(hostDeps(supervision, journal))
    const handle = host.startTurn(turnInput())
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).some(
          (msg) => msg.type === 'control_request' && msg.request?.subtype === 'initialize',
        ),
      ).toBe(true),
    )
    // Initialize is answered with an error: the engine never binds.
    const init = attachment.writes
      .map((line) => JSON.parse(line))
      .find((msg) => msg.type === 'control_request' && msg.request?.subtype === 'initialize')
    attachment.emitStdout(
      `${frame({ type: 'control_response', response: { subtype: 'error', request_id: init.request_id, error: 'nope' } })}\n`,
    )
    await expect(handle.done).rejects.toBeInstanceOf(EngineBindUnrecoverable)
    await vi.waitFor(() => expect(killed).toEqual(['podium-cl-claude-engine-session']))
    expect(journal.read(SESSION_ID)).toBeUndefined()
  })

  it('stops the engine with a scope sweep, retiring the journal only on retire', async () => {
    const attachment = fakeAttachment({ childPid: 4242 })
    const killed: string[] = []
    const { supervision, spawned } = fakeSupervision({ spawn: attachment, killed })
    const journal = journalStore()
    const host = createClaudeEngineHost(hostDeps(supervision, journal))
    const handle = host.startTurn(turnInput())
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    answerHandshake(attachment, 'claude-native-1')
    await vi.waitFor(() =>
      expect(
        attachment.writes.map((line) => JSON.parse(line)).some((msg) => msg.type === 'user'),
      ).toBe(true),
    )
    // Hibernate: the engine ends but the journal stays for the later resume.
    const stopping = host.stopEngine(SESSION_ID, false)
    attachment.exit(0, 0)
    await stopping
    expect(attachment.signals).toContain(15)
    expect(killed).toEqual(['podium-cl-claude-engine-session'])
    expect(journal.read(SESSION_ID)).toBeDefined()

    // Retire: the journal goes with the session.
    const attachment2 = fakeAttachment({ childPid: 5555 })
    const { supervision: supervision2, spawned: spawned2 } = fakeSupervision({ spawn: attachment2 })
    const host2 = createClaudeEngineHost(hostDeps(supervision2, journal))
    const handle2: ClaudeSdkTurnHandle = host2.startTurn(turnInput())
    void handle2
    await vi.waitFor(() => expect(spawned2).toHaveLength(1))
    answerHandshake(attachment2, 'claude-native-2')
    await vi.waitFor(() => expect(journal.read(SESSION_ID)?.claudeSessionId).toBe('claude-native-2'))
    const retiring = host2.stopEngine(SESSION_ID, true)
    attachment2.exit(0, 0)
    await retiring
    expect(journal.read(SESSION_ID)).toBeUndefined()
    await handle.done.catch(() => {})
  })

  it('releases holds without ending engines on dispose', async () => {
    const attachment = fakeAttachment({ childPid: 4242 })
    const killed: string[] = []
    const { supervision, spawned } = fakeSupervision({ spawn: attachment, killed })
    const journal = journalStore()
    const host = createClaudeEngineHost(hostDeps(supervision, journal))
    host.startTurn(turnInput())
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    host.releaseEngines()
    expect(attachment.disposed).toBe(true)
    expect(killed).toEqual([])
    // The journal stays: the next generation adopts the survivor.
    answerHandshake(attachment, 'claude-native-1')
    await vi.waitFor(() => expect(journal.read(SESSION_ID)).toBeDefined())
  })

  it('escalates a silent interrupt with SIGINT through the host', async () => {
    vi.useFakeTimers()
    try {
      const attachment = fakeAttachment({ childPid: 4242 })
      const { supervision, spawned } = fakeSupervision({ spawn: attachment })
      const host = createClaudeEngineHost(hostDeps(supervision, journalStore()))
      const handle = host.startTurn(turnInput())
      // Let the async bind run under fake timers.
      const binding = (async () => {
        for (let i = 0; i < 50 && spawned.length === 0; i++) {
          await vi.advanceTimersByTimeAsync(10)
        }
      })()
      await binding
      answerHandshake(attachment, 'claude-native-1')
      for (let i = 0; i < 50; i++) {
        const users = attachment.writes.map((line) => JSON.parse(line)).filter((msg) => msg.type === 'user')
        if (users.length > 0) break
        await vi.advanceTimersByTimeAsync(10)
      }
      const interrupt = handle.requestInterrupt
      if (!interrupt) throw new Error('the engine turn owes an interrupt answer')
      const ack = interrupt()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(ack).resolves.toMatchObject({ outcome: 'unconfirmed' })
      expect(attachment.signals).toContain(2)
      host.releaseEngines()
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)
})
