/**
 * ISSUE MAIL THROUGH THE CODEX SESSION ADAPTER.
 *
 * The mail continuation itself is the supervisor's wiring
 * (createMailContinuation over the mail context); this pins that the session
 * adapter actually drives it — the pump reads from 'bootstrap' through the
 * injected continuation, so a completed turn fetches context and a follow-up
 * turn carries it.
 */
import type { CodexRuntimeHost, CodexTransport } from '@podium/harness/driver/host'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { startFakeAppServer } from '../../../../packages/harness/src/driver/families/codex/test-support/fake-app-server'
import { codexEngineFacts } from '@podium/harness/driver/host'
import { manifestFor } from '@podium/harness'
import { createCodexSessionRuntime } from '@podium/harness/driver/host'
import { composeMailContext, createAckReminderInjector, createMailInjector } from '../mail-injector'
import { createMailContinuation } from './mail-boundary'
import { driverTiming } from './driver-timing'
import { driverSlotsOver } from '../session/driver-slots.js'
import { testSessions } from '../session/testing.js'


/** Just enough app-server to complete a handshake and resume a thread. */
function stubTransport(): { transport: CodexTransport; resumedThreads: string[] } {
  const resumedThreads: string[] = []
  let handler: { line(line: string): void; closed(): void } | undefined
  const reply = (payload: unknown): void => handler?.line(JSON.stringify(payload))
  return {
    resumedThreads,
    transport: {
      write(line) {
        const frame = JSON.parse(line) as {
          id?: number
          method?: string
          params?: Record<string, unknown>
        }
        if (frame.method === 'initialize') {
          // Note the missing `jsonrpc` member — the real server omits it, and a
          // stub that added one would be kinder than the thing it stands for.
          reply({ id: frame.id, result: { userAgent: 'stub', codexHome: '/home/a/.codex' } })
          return
        }
        if (frame.method === 'thread/resume') {
          const threadId = String(frame.params?.threadId)
          resumedThreads.push(threadId)
          reply({ id: frame.id, result: { thread: { id: threadId, path: null } } })
          return
        }
        if (frame.method === 'getAuthStatus') {
          reply({ id: frame.id, result: { authMethod: 'chatgpt' } })
          return
        }
        if (frame.id !== undefined) reply({ id: frame.id, result: {} })
      },
      onLine(next) {
        handler = next
      },
      close() {
        handler?.closed()
      },
    },
  }
}

function world(options: { sendThrows?: boolean } = {}) {
  const sent: DaemonMessage[] = []
  const entries = new Map<string, unknown>()
  const resumed: string[] = []
  let launches = 0
  const host: CodexRuntimeHost = {
    stageAttachment: async ({ source }) => ({
      id: 'test-attachment',
      path: '/tmp/test-' + source.filename,
      filename: source.filename,
      mediaType: source.mediaType,
      kind: source.mediaType.startsWith('image/') ? 'image' : 'file',
    }),
    bindings: {
      recorded: (id) => entries.get(id) as never,
      bound: (entry) => void entries.set(entry.sessionId, entry),
      released: (id) => void entries.delete(id),
    },
    now: () => Date.UTC(2026, 7, 14),
    mintSessionId: () => 'minted' as SessionId,
    async launch(input) {
      launches += 1
      const stub = stubTransport()
      // The stub's resumes are collected globally so the assertion can name the
      // thread id without reaching into whichever child served the adopt.
      const proxy: CodexTransport = {
        write: (line) => {
          stub.transport.write(line)
          resumed.push(...stub.resumedThreads.splice(0))
        },
        onLine: (h) => stub.transport.onLine(h),
        close: () => stub.transport.close(),
      }
      return {
        transport: proxy,
        clientAddress: `unix:///tmp/${input.sessionId}.sock`,
        process: { key: `podium-cx-${input.sessionId}` },
        stop: async () => {},
        kill: async () => {},
        resources: () => undefined,
      }
    },
  }
  return {
    host,
    sent,
    entries,
    resumed,
    launches: () => launches,
    runtime: createCodexSessionRuntime({ driverSlots: driverSlotsOver(testSessions()),
      facts: codexEngineFacts(manifestFor('codex')!),
      engine: host,
      send: (msg) => {
        sent.push(msg)
      },
      emitBind: (bind) => {
        sent.push({ type: 'bind', ...bind })
      },
      sessionReady: (binding) => driverTiming.sessionReady(binding),
      traceRuntimeEvent: (binding, event) => driverTiming.runtimeEvent(binding, event),
      startMailContinuation: () => () => {},
    }),
  }
}



describe('issue mail without terminal callbacks', () => {
  it.each(['unread', 'reminder', 'empty', 'failed'] as const)('handles %s at completion with the correct active state and no mail loop', async (mode) => {
    const base = world()
    const server = startFakeAppServer()
    let now = 0
    let polls = 0
    const mail = createMailInjector(async () => {
      polls++
      if (mode === 'failed') throw new Error('relay offline')
      return { ok: true, result: { unread: mode === 'unread' ? 2 : 0, senders: ['coordinator'] } }
    }, () => now)
    const ack = createAckReminderInjector(async () => ({ ok: true, result:
      mode === 'reminder' ? [{ id: 'msg_reply', from: 'coordinator' }] : [] }), () => now)
    const runtime = createCodexSessionRuntime({ driverSlots: driverSlotsOver(testSessions()),
      facts: codexEngineFacts(manifestFor('codex')!),
      engine: {
        ...base.host,
        launch: async () => ({
          transport: server.transport,
          clientAddress: 'unix:///tmp/boundary-test.sock',
          process: { key: 'boundary-test' },
          stop: async () => {},
          kill: async () => {},
          resources: () => undefined,
        }),
      },
      send: () => {},
      emitBind: () => {},
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: (handle, isCurrent) =>
        createMailContinuation(
          handle,
          composeMailContext(mail, ack).pendingContext,
          isCurrent,
          () => {},
        ),
    })
    try {
      const sessionId = 'boundary-mail' as SessionId
      await runtime.launch({ sessionId, cwd: '/work' })
      const handle = runtime.handleFor(sessionId)!
      await handle.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
      expect(polls).toBe(0)
      server.completeTurn('completed')
      if (mode === 'empty' || mode === 'failed') {
        await expect.poll(() => polls).toBe(1)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(server.turnStarts).toBe(1)
        expect((await handle.state()).phase).toBe('idle')
        return
      }
      await expect.poll(() => server.turnStarts).toBe(2)
      expect((await handle.state()).phase).toBe('working')
      expect(JSON.stringify(server.lastTurnInput)).toContain(mode === 'unread' ? 'podium issue mail inbox' : 'podium mail reply msg_reply')
      expect(JSON.stringify(server.lastTurnInput)).toContain('coordinator')
      // Even when the cooldown expires, the mail turn cannot remind itself.
      now = 120_000
      server.completeTurn('completed')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(server.turnStarts).toBe(2)
      expect(polls).toBe(1)
      expect((await handle.state()).phase).toBe('idle')
    } finally {
      runtime.dispose()
      base.runtime.dispose()
    }
  })
})
