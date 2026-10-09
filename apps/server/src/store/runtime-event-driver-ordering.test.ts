import { firstAdminMemberId, type AgentRuntimeState } from '@podium/model'
import type { ControlMessage, RuntimeEvent } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle } from '../../../../packages/harness/src/driver/driver.js'
import type { SessionSpec } from '../../../../packages/harness/src/driver/session-spec.js'
import { createMemoryDriverSlots } from '../../../../packages/harness/src/driver/testing/index.js'
import {
  createCodexRuntime,
  type CodexRuntimeHost,
} from '../../../../packages/harness/src/driver/families/codex/runtime.js'
import { startFakeAppServer } from '../../../../packages/harness/src/driver/families/codex/test-support/fake-app-server.js'
import {
  createGrokAcpRuntime,
  type GrokAcpRuntimeHost,
} from '../../../../packages/harness/src/driver/families/grok-acp/runtime.js'
import { startFakeGrokAcpServer } from '../../../../packages/harness/src/driver/families/grok-acp/test-support/fake-acp-server.js'
import type { OpencodeClient } from '../../../../packages/harness/src/driver/families/opencode/client.js'
import type {
  OpencodeEvent,
  OpencodeMessageWithParts,
} from '../../../../packages/harness/src/driver/families/opencode/protocol.js'
import {
  createOpencodeRuntime,
  type OpencodeRuntimeHost,
} from '../../../../packages/harness/src/driver/families/opencode/runtime.js'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'

const AT = 1_786_700_000_000
const options = { origin: 'human', delivery: 'when-ready' } as const
const bindings = () => ({ recorded: () => undefined, bound() {}, released() {} })
const history = async () => ({ items: [], hasMore: false })

function spec(
  harness: string,
  driver: 'grok-acp' | 'opencode-server' | 'opencode2-server' | 'codex-app-server',
): SessionSpec {
  return {
    harness,
    workdir: '/ordering-fixture',
    model: {},
    selection: {
      auth: harness === 'opencode' ? 'api-key' : 'subscription',
      platform: 'linux',
      available: [driver],
    },
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
  }
}

/** Real ingress, durable checkpoint and session projection; only providers are fake. */
async function sessionWorld(agentKind: 'grok' | 'opencode' | 'codex', driverId: string) {
  const store = await openTestStore(':memory:')
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const commands: ControlMessage[] = []
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'Host',
    hostname: 'test',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: true, agentExecution: true },
  })
  await registry.gateway.attachDaemon(store.hostMachineId, (message) => {
    commands.push(message)
  })
  const { sessionId } = await registry.modules.sessions.createSession({
    agentKind,
    cwd: '/ordering-fixture',
  })
  await registry.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'fixture',
    cwd: '/ordering-fixture',
    agentKind,
    geometry: { cols: 80, rows: 24 },
    driverId,
  })
  let clock = AT
  return {
    sessionId,
    now: () => ++clock,
    checkpoint: () => store.events.runtimeEventCheckpoint(sessionId),
    async observe(handle: AgentSessionHandle) {
      const snapshot = await handle.snapshot()
      let after = snapshot.cursor
      const forwarded: RuntimeEvent[] = []
      async function send(event: RuntimeEvent) {
        const deliveryId = `ordering-${forwarded.length}`
        await registry.gateway.routeDaemonFrame(store.hostMachineId, {
          type: 'runtimeEvent',
          sessionId,
          deliveryId,
          event,
        })
        expect(
          commands.find(
            (command) => command.type === 'runtimeEventAck' && command.deliveryId === deliveryId,
          ),
          `ingress for ${event.t} in epoch ${event.turnEpoch}`,
        ).toMatchObject({ outcome: 'committed' })
        forwarded.push(event)
        // A committed duplicate also gets an ack. Exact log equality proves
        // each new activity event was persisted once. Delivery reports are
        // applied directly to inbox rows, outside the runtime activity log.
        expect(await store.events.listRuntimeEvents(sessionId)).toEqual(
          forwarded.filter((event) => event.t !== 'delivery'),
        )
      }
      // The daemon bootstraps the driver's snapshot before forwarding live deltas.
      await send({
        t: 'state',
        change: { kind: 'state_snapshot', state: snapshot.state },
        at: snapshot.at,
        provenance: 'bootstrap',
        cursor: snapshot.cursor,
        observerGeneration: snapshot.observerGeneration,
        turnEpoch: snapshot.turnEpoch,
      })
      return {
        forwarded,
        async forward() {
          const target = (await handle.snapshot()).cursor
          if (after.components.seq === target.components.seq) return
          for await (const event of handle.events(after)) {
            await send(event)
            after = event.cursor
            if (after.components.seq === target.components.seq) break
          }
        },
        async agree(phase: AgentRuntimeState['phase']) {
          const local = await handle.state()
          expect(local.phase).toBe(phase)
          const visible = await registry.modules.sessions.sessionById(sessionId)
          expect(visible?.agentState).toMatchObject(local)
        },
        async started(epoch: number, origin = 'human') {
          const events = forwarded.filter((event) => event.turnEpoch === epoch)
          expect(events[0]).toMatchObject({
            t: 'turn',
            ev: { ev: 'started', turnEpoch: epoch, origin },
          })
          expect(
            events.filter((event) => event.t === 'turn' && event.ev.ev === 'started'),
          ).toHaveLength(1)
          expect(events.some((event) => event.t === 'state')).toBe(true)
          expect(await store.events.runtimeEventCheckpoint(sessionId)).toMatchObject({
            turnEpoch: epoch,
          })
        },
      }
    },
    async close() {
      await registry.dispose()
      await store.close()
    },
  }
}

/** An in-memory SSE source with a barrier after the runtime ingests each event. */
function eventFeed() {
  const queue: { event: OpencodeEvent; done(): void }[] = []
  let wake: (() => void) | undefined
  return {
    emit(event: OpencodeEvent): Promise<void> {
      return new Promise((done) => {
        queue.push({ event, done })
        wake?.()
      })
    },
    async *events(signal: AbortSignal) {
      const abort = () => wake?.()
      signal.addEventListener('abort', abort)
      try {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) {
            yield next.event
            next.done()
          } else
            await new Promise<void>((resolve) => {
              wake = resolve
            })
        }
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
  }
}

function opencodeHost(
  w: Awaited<ReturnType<typeof sessionWorld>>,
  driverId: 'opencode-server' | 'opencode2-server',
) {
  const feed = eventFeed()
  const nativeId = 'ses_ordering'
  const messages: OpencodeMessageWithParts[] = []
  const client: OpencodeClient = {
    baseUrl: 'http://fixture.invalid',
    health: async () => true,
    createSession: async () => ({ id: nativeId }),
    getSession: async () => ({ id: nativeId }),
    async prompt(_id, body) {
      const text = body.parts.find((part) => part.type === 'text')
      if (!text?.id) throw new Error('missing native text part id')
      messages.push({
        info: { id: body.messageID, sessionID: nativeId, role: 'user', time: { created: w.now() } },
        parts: [
          {
            id: text.id,
            messageID: body.messageID,
            sessionID: nativeId,
            type: 'text',
            text: text.text,
          },
        ],
      })
      return driverId === 'opencode2-server' ? { held: 'durable' } : {}
    },
    ...(driverId === 'opencode2-server' ? { pendingPrompts: async () => [] } : {}),
    abort: async () => {},
    messages: async () => messages,
    permissions: async () => [],
    questions: async () => [],
    replyPermission: async () => {},
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    events: feed.events,
  }
  const host: OpencodeRuntimeHost = {
    driverId,
    now: w.now,
    mintSessionId: () => w.sessionId,
    randomSecret: () => 'fixture',
    bindings: bindings(),
    launch: async () => ({
      baseUrl: client.baseUrl,
      username: 'fixture',
      password: 'fixture',
      process: { key: 'ordering' },
      stop: async () => {},
      kill: async () => {},
      resources: () => undefined,
    }),
    adopt: async () => undefined,
    attachClient: async () => undefined,
    readHistory: history,
    makeClient: () => client,
    stageAttachment: async () => {
      throw new Error('unused')
    },
  }
  return { host, feed, nativeId }
}

function codexHost(w: Awaited<ReturnType<typeof sessionWorld>>, earlyStatus: boolean) {
  const server = startFakeAppServer()
  let startingId: number | undefined
  const host: CodexRuntimeHost = {
    now: w.now,
    mintSessionId: () => w.sessionId,
    bindings: bindings(),
    rolloutExists: async () => false,
    readHistory: history,
    stageAttachment: async () => {
      throw new Error('unused')
    },
    launch: async () => ({
      process: { key: 'ordering' },
      clientAddress: 'unix:///ordering-fixture',
      stop: async () => server.close(),
      kill: async () => server.close(),
      resources: () => undefined,
      transport: {
        close: () => server.transport.close(),
        write(line) {
          const frame = JSON.parse(line)
          if (frame.method === 'turn/start') startingId = frame.id
          server.transport.write(line)
        },
        onLine(handler) {
          server.transport.onLine({
            closed: () => handler.closed(),
            line(line) {
              const frame = JSON.parse(line)
              if (earlyStatus && frame.id === startingId && frame.result?.turn) {
                handler.line(
                  JSON.stringify({
                    method: 'thread/status/changed',
                    params: {
                      threadId: server.threadId,
                      status: { type: 'active', activeFlags: [] },
                    },
                  }),
                )
              }
              handler.line(line)
            },
          })
        },
      },
    }),
  }
  return { host, server }
}

describe('driver turn-start ordering through the server projection', () => {
  it('projects a queued Grok acknowledgement and a drained prompt after the previous epoch closes', async () => {
    const w = await sessionWorld('grok', 'grok-acp')
    const server = startFakeGrokAcpServer('grok-ordering', { ackPrompt: 'hold' })
    const host: GrokAcpRuntimeHost = {
      now: w.now,
      mintSessionId: () => w.sessionId,
      bindings: bindings(),
      readHistory: history,
      launch: async () => ({
        transport: server.transport,
        process: { key: 'ordering' },
        alive: () => server.alive,
        stop: async () => {},
        kill: async () => {},
        resources: () => undefined,
      }),
    }
    const runtime = createGrokAcpRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec('grok', 'grok-acp'))
      const p = await w.observe(handle)
      const first = handle.send({ id: 'first', text: 'first' }, options)
      await expect.poll(() => server.promptCount).toBe(1)
      server.ackPrompt('queued')
      expect(await first).toMatchObject({ outcome: 'accepted', turnEpoch: 1 })
      await p.forward()
      await p.started(1)
      await p.agree('working')

      expect(
        await handle.send({ id: 'second', text: 'second' }, { ...options, delivery: 'queue' }),
      ).toMatchObject({ outcome: 'queued' })
      server.completeTurn()
      await expect.poll(() => server.promptCount).toBe(2)
      await p.forward()
      await p.agree('idle')
      expect(await w.checkpoint()).toMatchObject({ closedTurnEpoch: 1 })
      server.ackPrompt('queued')
      await p.forward()
      await p.started(2)
      await p.agree('working')
    } finally {
      runtime.dispose()
      await w.close()
    }
  })

  for (const driver of ['opencode-server', 'opencode2-server'] as const) {
    it.each([
      'busy',
      'retry',
    ] as const)(`${driver}: projects external %s turns, including after a closed epoch`, async (status) => {
      const w = await sessionWorld('opencode', driver)
      const f = opencodeHost(w, driver)
      const runtime = createOpencodeRuntime(f.host, createMemoryDriverSlots())
      try {
        const handle = await runtime.driver.create(spec('opencode', driver))
        const p = await w.observe(handle)
        const busy: OpencodeEvent = {
          id: 'evt_status',
          type: 'session.status',
          properties: {
            sessionID: f.nativeId,
            status:
              status === 'busy'
                ? { type: 'busy' }
                : { type: 'retry', attempt: 1, message: 'retry', next: AT + 1000 },
          },
        }
        await f.feed.emit(busy)
        await p.forward()
        await p.started(1)
        await p.agree('working')
        await f.feed.emit(busy)
        await p.forward()
        await p.started(1)
        await f.feed.emit({
          id: 'evt_idle',
          type: 'session.idle',
          properties: { sessionID: f.nativeId },
        })
        await p.forward()
        await p.agree('idle')
        expect(await w.checkpoint()).toMatchObject({ closedTurnEpoch: 1 })
        await f.feed.emit(busy)
        await p.forward()
        await p.started(2)
        await p.agree('working')
      } finally {
        runtime.dispose()
        await w.close()
      }
    })

    it(`${driver}: projects working from the provisional prompt start before status arrives`, async () => {
      const w = await sessionWorld('opencode', driver)
      const f = opencodeHost(w, driver)
      const runtime = createOpencodeRuntime(f.host, createMemoryDriverSlots())
      try {
        const handle = await runtime.driver.create(spec('opencode', driver))
        const p = await w.observe(handle)
        expect(await handle.send({ id: 'msg_ordering', text: 'work' }, options)).toMatchObject({
          outcome: 'accepted',
          turnEpoch: 1,
        })
        await p.forward()
        await p.started(1)
        await p.agree('working')
        await f.feed.emit({
          id: 'evt_status',
          type: 'session.status',
          properties: { sessionID: f.nativeId, status: { type: 'busy' } },
        })
        await p.forward()
        await p.started(1)
        await p.agree('working')
      } finally {
        runtime.dispose()
        await w.close()
      }
    })
  }

  it.each([
    false,
    true,
  ])('Codex admits active status around the synchronous start ack (early=%s)', async (early) => {
    const w = await sessionWorld('codex', 'codex-app-server')
    const f = codexHost(w, early)
    const runtime = createCodexRuntime(f.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec('codex', 'codex-app-server'))
      const p = await w.observe(handle)
      for (const epoch of [1, 2]) {
        f.server.deferTurnStarted()
        expect(
          await handle.send(
            { id: `prompt-${epoch}`, text: 'work' },
            { ...options, origin: 'system' },
          ),
        ).toMatchObject({ outcome: 'accepted', turnEpoch: epoch })
        await p.forward()
        await p.started(epoch, 'system')
        await p.agree('working')
        // The ack opens a provisional epoch, while steering still waits for
        // the provider's turn/started. Releasing it cannot open another epoch.
        f.server.releaseTurnStarted()
        await p.forward()
        await p.started(epoch, 'system')
        await p.agree('working')
        f.server.completeTurn()
        await p.forward()
        await p.agree('idle')
        expect(await w.checkpoint()).toMatchObject({ closedTurnEpoch: epoch })
      }
      // Also dispatch status + started synchronously after the answer, before
      // deliver's promise resumes (the fake server's normal frame ordering).
      expect(
        await handle.send({ id: 'prompt-3', text: 'work' }, { ...options, origin: 'system' }),
      ).toMatchObject({ outcome: 'accepted', turnEpoch: 3 })
      await p.forward()
      await p.started(3, 'system')
      await p.agree('working')
    } finally {
      runtime.dispose()
      await w.close()
    }
  })

  it('Codex projects externally opened turns and a raced start that the provider delivers as steer', async () => {
    const w = await sessionWorld('codex', 'codex-app-server')
    const f = codexHost(w, false)
    const runtime = createCodexRuntime(f.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec('codex', 'codex-app-server'))
      const p = await w.observe(handle)
      f.server.openForeignTurn()
      await p.forward()
      await p.started(1)
      await p.agree('working')
      f.server.completeTurn()
      await p.forward()
      await p.agree('idle')
      expect(await w.checkpoint()).toMatchObject({ closedTurnEpoch: 1 })
      f.server.raceForeignTurnOnNextTurnStart()
      expect(await handle.send({ id: 'raced', text: 'steer' }, options)).toMatchObject({
        outcome: 'accepted',
        deliveredAs: 'steer',
        turnEpoch: 2,
      })
      await p.forward()
      await p.started(2)
      await p.agree('working')
    } finally {
      runtime.dispose()
      await w.close()
    }
  })
})
