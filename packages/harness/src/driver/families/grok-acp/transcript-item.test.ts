/**
 * A GROK PROMPT CARRIES OUR ID, AND IS CONFIRMED BY IT (POD-4837).
 *
 * Measured on grok 1.0.44 (`__fixtures__/live-frames.jsonl`): a client that
 * sends `_meta.promptId` on `session/prompt` owns that id. Grok names it in
 * `_x.ai/queue/changed` within milliseconds, stamps every update of the turn
 * with it, and answers the request under it. Grok never sends the prompt's own
 * `user_message_chunk` to the live client; it writes it to the session's
 * history, and a `session/load` replays it ahead of the turn's stamped updates.
 *
 * The queue ack accepts a held message. Only reading the stored user chunk,
 * bound by a following record stamped with our id, confirms it. A prompt a
 * Grok hook drops names no entry and calls onUnrecorded.
 */

import type { SessionId, TranscriptItem, TranscriptItemRef } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent, SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import type { TurnReceipt } from '../../turns.js'
import {
  createGrokAcpRuntime,
  type GrokAcpJournalEntry,
  type GrokAcpRuntimeHost,
} from './runtime.js'
import {
  type FakeGrokAcpServer,
  type FakeGrokAcpServerOptions,
  type FakeGrokStoredUpdate,
  startFakeGrokAcpServer,
} from './test-support/fake-acp-server.js'

const spec = (): SessionSpec => ({
  harness: 'grok',
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['grok-acp'],
    preference: 'grok-acp',
  },
  workdir: '/tmp/grok-transcript-item',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

function world(options: FakeGrokAcpServerOptions = {}): {
  host: GrokAcpRuntimeHost
  serverFor(sessionId: SessionId): FakeGrokAcpServer
} {
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  // Grok's store outlives its process: a load replays what an earlier one wrote.
  const store = new Map<string, FakeGrokStoredUpdate[]>()
  const frameStore = new Map<string, Record<string, unknown>[]>()
  return {
    serverFor: (sessionId) => servers.get(sessionId)!,
    host: {
      bindings: {
        recorded: (id) => entries.get(id),
        bound: (entry) => entries.set(entry.sessionId, entry),
        released: (id) => {
          entries.delete(id)
        },
      },
      now: () => Date.UTC(2026, 7, 20) + ++seq * 1000,
      nativeArchivePollMs: 1,
      mintSessionId: () => `gk-item-${++seq}` as SessionId,
      readHistory: async () => ({ items: [], hasMore: false }),
      async readNativeUpdates({ grokSessionId, offset }) {
        const bytes = new TextEncoder().encode(
          (frameStore.get(grokSessionId) ?? [])
            .map((frame) => JSON.stringify(frame) + '\n')
            .join(''),
        )
        const start = bytes.length < offset ? 0 : offset
        return { offset: start, bytes: bytes.subarray(start) }
      },
      async launch(input) {
        const server = startFakeGrokAcpServer(`grok-native-${input.sessionId}`, {
          ...options,
          store,
          frameStore,
        })
        servers.set(input.sessionId, server)
        return {
          transport: server.transport,
          process: { key: `podium-gk-${input.sessionId}`, pid: 4000 + seq },
          alive: () => server.alive,
          stop: async () => server.crash(),
          kill: async () => server.crash(),
          resources: () => undefined,
        }
      },
    },
  }
}

const userItems = (items: readonly TranscriptItem[]): TranscriptItem[] =>
  items.filter((item) => item.role === 'user')

/**
 * The completed items the chat is shown, as the driver emits them. On dev/mw
 * `transcript.history` is a Store read (POD-4782), so the live item stream —
 * not driver memory — is where the naming must agree with the chat. Collects
 * from `cursor` until `enough` holds, or gives up after `ms`.
 */
async function shownItems(
  handle: { events(after: never): AsyncIterable<RuntimeEvent> },
  cursor: unknown,
  enough: (items: readonly TranscriptItem[]) => boolean,
  ms = 2_000,
): Promise<TranscriptItem[]> {
  const items: TranscriptItem[] = []
  const iterator = handle.events(cursor as never)[Symbol.asyncIterator]()
  const deadline = Date.now() + ms
  try {
    while (!enough(items) && Date.now() < deadline) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
      ])
      if (next === null || next.done) break
      const event = next.value
      if (event.t === 'item' && event.item.kind === 'complete') items.push(event.item.item)
    }
  } finally {
    void iterator.return?.()
  }
  return items
}

/** Settles `true` once `promise` has settled, `false` while it is pending. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  return done
}

describe('a Grok prompt carries our id', () => {
  it("sends the message id as the prompt's _meta.promptId", async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      await handle.send(
        { id: 'msg_ship', text: 'ship it' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(w.serverFor(handle.binding.sessionId).prompts.at(-1)).toMatchObject({
        prompt: [{ type: 'text', text: 'ship it' }],
        _meta: { promptId: 'msg_ship' },
      })
    } finally {
      runtime.dispose()
    }
  })

  it('mints a promptId of its own for a send that carries no id', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const receipt = await handle.send(
        { text: 'no id' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({ outcome: 'accepted', provenBy: 'protocol-ack' })
      const promptId = (
        w.serverFor(handle.binding.sessionId).prompts.at(-1)?._meta as {
          promptId?: unknown
        }
      )?.promptId
      expect(typeof promptId).toBe('string')
      expect(promptId).not.toBe('')
    } finally {
      runtime.dispose()
    }
  })
})

describe('accepted only when Grok names our id', () => {
  it('holds the receipt until the queue ack names the prompt, and opens the turn then', async () => {
    const w = world({ ackPrompt: 'hold' })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      const sent = handle.send(
        { id: 'msg_held', text: 'held' },
        { origin: 'human', delivery: 'when-ready' },
      )
      await expect.poll(() => w.serverFor(handle.binding.sessionId).promptCount).toBe(1)
      expect(await settled(sent)).toBe(false)
      // Taken, not yet in a turn: no epoch moved and no turn started.
      expect((await handle.snapshot()).turnEpoch).toBe(before.turnEpoch)
      w.serverFor(handle.binding.sessionId).ackPrompt()
      const receipt = await sent
      expect(receipt).toMatchObject({
        outcome: 'accepted',
        provenBy: 'protocol-ack',
        held: 'memory',
        turnEpoch: before.turnEpoch + 1,
      })
      const events: RuntimeEvent[] = []
      for await (const event of handle.events(before.cursor)) {
        events.push(event)
        if (event.t === 'turn') break
      }
      expect(events.at(-1)).toMatchObject({
        t: 'turn',
        ev: { ev: 'started', turnEpoch: before.turnEpoch + 1 },
      })
    } finally {
      runtime.dispose()
    }
  })

  it.each([
    ['the queued entry alone, as when Grok holds it behind a turn of its own', 'queued'],
    ['the running frame alone', 'running'],
  ] as const)('is accepted on %s', async (_label, stage) => {
    const w = world({ ackPrompt: 'hold' })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const sent = handle.send(
        { id: `msg_${stage}`, text: stage },
        { origin: 'human', delivery: 'when-ready' },
      )
      await expect.poll(() => w.serverFor(handle.binding.sessionId).promptCount).toBe(1)
      w.serverFor(handle.binding.sessionId).ackPrompt(stage)
      expect(await settled(sent)).toBe(true)
      await expect(sent).resolves.toMatchObject({ outcome: 'accepted', provenBy: 'protocol-ack' })
    } finally {
      runtime.dispose()
    }
  })

  it('holds an interrupt that comes before the ack for the turn the ack opens', async () => {
    const w = world({ ackPrompt: 'hold' })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const server = w.serverFor(handle.binding.sessionId)
      const sent = handle.send(
        { id: 'msg_stop', text: 'stop me' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const interrupted = handle.interrupt()
      expect(await settled(interrupted)).toBe(false)
      // Nothing is cancelled before Grok has named the prompt.
      expect(server.cancels).toBe(0)
      await expect.poll(() => server.promptCount).toBe(1)
      server.ackPrompt()
      await interrupted
      expect(server.cancels).toBe(1)
      await expect(sent).resolves.toMatchObject({ outcome: 'accepted' })
      await expect.poll(async () => (await handle.state()).phase).not.toBe('working')
    } finally {
      runtime.dispose()
    }
  })

  it('leaves a reply alone unproven when no queue ack or recorded turn named our id', async () => {
    const w = world({ ackPrompt: false })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const sent = handle.send(
        { id: 'msg_old', text: 'old build' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(await settled(sent)).toBe(false)
      await expect.poll(() => w.serverFor(handle.binding.sessionId).promptCount).toBe(1)
      // No live output or stamped file record; the reply is only a turn fence.
      w.serverFor(handle.binding.sessionId).completeTurn('cancelled')
      await expect(sent).rejects.toThrow(/without acknowledging or recording/)
    } finally {
      runtime.dispose()
    }
  })

  it('is unproven, never refused, and opens no turn, when Grok answers an error before naming it', async () => {
    // NO GROK ERROR REPLY IS MEASURED AS RECORDING NOTHING (POD-4834; a model
    // error there is recorded), so it is not a "no" (POD-4839, POD-4819 §7).
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      w.serverFor(handle.binding.sessionId).failNextPrompt('invalid params')
      await expect(
        handle.send(
          { id: 'msg_rejected', text: 'rejected' },
          { origin: 'human', delivery: 'when-ready' },
        ),
      ).rejects.toThrow(/invalid params/)
      expect((await handle.snapshot()).turnEpoch).toBe(before.turnEpoch)
      // Nothing holds the session: the next send goes straight through.
      await expect(
        handle.send({ id: 'msg_next', text: 'next' }, { origin: 'human', delivery: 'when-ready' }),
      ).resolves.toMatchObject({ outcome: 'accepted' })
    } finally {
      runtime.dispose()
    }
  })
})

describe('a prompt Grok may hold is never refused (POD-4839)', () => {
  it('is unproven when the pipe closes after the prompt was written and before Grok named it', async () => {
    const w = world({ ackPrompt: 'hold' })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const pending = handle.send(
        { id: 'msg_lost', text: 'maybe recorded' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const server = w.serverFor(handle.binding.sessionId)
      await expect.poll(() => server.promptCount).toBe(1)
      server.crash()
      await expect(pending).rejects.toThrow()
    } finally {
      runtime.dispose()
    }
  })

  it('refuses a prompt its client never wrote', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      w.serverFor(handle.binding.sessionId).crash()
      await expect(
        handle.send(
          { id: 'msg_after', text: 'after' },
          { origin: 'human', delivery: 'when-ready' },
        ),
      ).resolves.toMatchObject({ outcome: 'refused', refusal: { reason: 'not_running' } })
    } finally {
      runtime.dispose()
    }
  })
})

describe('the entry is named by our id once Grok recorded the prompt', () => {
  it('names grok-user-<id> after reading the stored chunk and the stamped turn update', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      const named: TranscriptItemRef[] = []
      const receipt = await handle.send(
        { id: 'msg_ship', text: 'ship it' },
        { origin: 'human', delivery: 'when-ready', onTranscriptItem: (item) => named.push(item) },
      )
      // The ack comes before Grok says anything about the turn's progress.
      expect(receipt).toMatchObject({
        outcome: 'accepted',
        held: 'memory',
        provenBy: 'protocol-ack',
      })
      expect(receipt.outcome === 'accepted' && receipt.transcriptItem).toBeFalsy()
      expect(named).toEqual([])
      const server = w.serverFor(handle.binding.sessionId)
      server.streamAgentText(['on it'])
      await expect.poll(() => named).toEqual([{ id: 'grok-user-msg_ship' }])
      server.completeTurn()
      // Shown once, under the name, ahead of the answer it prompted.
      const shown = await shownItems(handle, before.cursor, (items) =>
        items.some((item) => item.role === 'assistant'),
      )
      expect(shown.map((item) => [item.role, item.id])).toEqual([
        ['user', 'grok-user-msg_ship'],
        ['assistant', expect.any(String)],
      ])
      // Named once.
      expect(named).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })

  it('waits past an allowing hook until the user chunk is bound by a later file record', async () => {
    const w = world({ promptHook: true })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const named: TranscriptItemRef[] = []
      await handle.send(
        { id: 'msg_hooked', text: 'hooked' },
        { origin: 'human', delivery: 'when-ready', onTranscriptItem: (item) => named.push(item) },
      )
      expect(named).toEqual([])
      const server = w.serverFor(handle.binding.sessionId)
      server.runPromptHook('allow')
      expect(named).toEqual([])
      server.streamAgentText(['on it'])
      await expect.poll(() => named).toEqual([{ id: 'grok-user-msg_hooked' }])
    } finally {
      runtime.dispose()
    }
  })

  it('names nothing on an update Grok sends before its hooks ran', async () => {
    const w = world({ promptHook: true })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const named: TranscriptItemRef[] = []
      await handle.send(
        { id: 'msg_early', text: 'early' },
        { origin: 'human', delivery: 'when-ready', onTranscriptItem: (item) => named.push(item) },
      )
      // Stamped with our id, but ahead of the hook verdict: not a record yet.
      w.serverFor(handle.binding.sessionId).pushStampedUpdate(
        { sessionUpdate: 'hook_run_started', event_name: 'user_prompt_submit', count: 1 },
        '_x.ai/session_notification',
      )
      expect(named).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('names nothing for a prompt the hook blocked: Grok never recorded it', async () => {
    const w = world({ promptHook: true })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      const named: TranscriptItemRef[] = []
      const unrecorded: [string, string | undefined][] = []
      const receipt = await handle.send(
        { id: 'msg_blocked', text: 'blocked' },
        {
          origin: 'human',
          delivery: 'when-ready',
          onTranscriptItem: (item) => named.push(item),
          onUnrecorded: (reason, proof) => unrecorded.push([reason, proof]),
        },
      )
      // Grok took it (the queue ack) before its hook refused it.
      expect(receipt).toMatchObject({ outcome: 'accepted' })
      w.serverFor(handle.binding.sessionId).runPromptHook('block')
      await expect.poll(async () => (await handle.state()).phase).not.toBe('working')
      expect(named).toEqual([])
      expect(unrecorded).toEqual([['dropped by a Grok hook', 'dropped-by-agent']])
      expect(userItems(await shownItems(handle, before.cursor, () => false, 200))).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('settles a durable row as delivered only once the file names its entry', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      await handle.send(
        { id: 'msg_row', text: 'durable', rowId: 'msg_row' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const server = w.serverFor(handle.binding.sessionId)
      await expect.poll(() => server.promptCount).toBe(1)
      const iterator = handle.events(before.cursor)[Symbol.asyncIterator]()
      const next = async (): Promise<RuntimeEvent> => {
        for (;;) {
          const step = await iterator.next()
          if (step.done) throw new Error('event stream ended')
          if (step.value.t === 'delivery') return step.value
        }
      }
      expect(await next()).toMatchObject({
        t: 'delivery',
        rowId: 'msg_row',
        outcome: 'accepted',
        held: 'memory',
      })
      const outcome = next()
      expect(await settled(outcome)).toBe(false)
      server.streamAgentText(['on it'])
      expect(await outcome).toMatchObject({
        t: 'delivery',
        rowId: 'msg_row',
        outcome: 'delivered',
        transcriptItem: { id: 'grok-user-msg_row' },
      })
      await iterator.return?.()
    } finally {
      runtime.dispose()
    }
  })
  it('settles a durable row its hook blocked as not delivered, never unknown (POD-4887)', async () => {
    // Measured (grok-acp 1.0.44, README §Grok): a blocking UserPromptSubmit hook
    // ends our turn `cancelled` with `HookDenied` and writes nothing. That is
    // Grok's own record of the drop: `failed`/`dropped-by-agent`, safe to resend.
    const w = world({ promptHook: true })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      await handle.send(
        { id: 'msg_denied', text: 'blocked', rowId: 'msg_denied' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const server = w.serverFor(handle.binding.sessionId)
      await expect.poll(() => server.promptCount).toBe(1)
      const iterator = handle.events(before.cursor)[Symbol.asyncIterator]()
      const next = async (): Promise<RuntimeEvent> => {
        for (;;) {
          const step = await iterator.next()
          if (step.done) throw new Error('event stream ended')
          if (step.value.t === 'delivery') return step.value
        }
      }
      expect(await next()).toMatchObject({ rowId: 'msg_denied', outcome: 'accepted' })
      server.runPromptHook('block')
      expect(await next()).toMatchObject({
        t: 'delivery',
        rowId: 'msg_denied',
        outcome: 'failed',
        cause: 'dropped-by-agent',
      })
      await iterator.return?.()
    } finally {
      runtime.dispose()
    }
  })
})

describe("Grok's own history names the entry by the same id", () => {
  it('a loaded session keys the replayed prompt by the promptId of its turn', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      await handle.send(
        { id: 'msg_kept', text: 'kept' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const server = w.serverFor(handle.binding.sessionId)
      server.streamAgentText(['done'])
      server.completeTurn()
      await expect.poll(async () => (await handle.state()).phase).toBe('idle')
      const live = userItems(
        await shownItems(handle, before.cursor, (items) => userItems(items).length > 0),
      ).map((item) => item.id)
      expect(live).toEqual(['grok-user-msg_kept'])
      const resumed = await runtime.driver.resume(
        { kind: 'grok-session', value: server.sessionId },
        spec(),
      )
      // The load's replay, as the resumed driver shows it.
      const replayed = userItems(
        await shownItems(resumed, undefined, (items) => userItems(items).length > 0),
      )
      expect(replayed.map((item) => [item.id, item.text])).toEqual([['grok-user-msg_kept', 'kept']])
    } finally {
      runtime.dispose()
    }
  })

  it('a message Grok already holds is not sent again: accepted, naming the same entry', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      await handle.send(
        { id: 'msg_once', text: 'once' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const server = w.serverFor(handle.binding.sessionId)
      server.streamAgentText(['done'])
      server.completeTurn()
      await expect.poll(async () => (await handle.state()).phase).toBe('idle')
      // A daemon restart loses the receipt: the same message comes again, to a
      // session loaded from Grok's own history.
      const resumed = await runtime.driver.resume(
        { kind: 'grok-session', value: server.sessionId },
        spec(),
      )
      const again = w.serverFor(resumed.binding.sessionId)
      const receipt: TurnReceipt = await resumed.send(
        { id: 'msg_once', text: 'once' },
        { origin: 'human', delivery: 'when-ready' },
      )
      // The proof is the entry in Grok's own history, not an ack of this send.
      expect(receipt).toMatchObject({
        outcome: 'accepted',
        provenBy: 'transcript-echo',
        transcriptItem: { id: 'grok-user-msg_once' },
      })
      // Grok runs a repeated promptId as a second turn (measured), so the
      // driver must not send it.
      expect(again.promptCount).toBe(0)
      await expect.poll(async () => (await resumed.state()).phase).toBe('idle')
    } finally {
      runtime.dispose()
    }
  })
})

describe("Grok's own id for our message (POD-4841)", () => {
  it('names the promptId the prompt runs under, on the receipt and with the entry', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const named: unknown[] = []
      const receipt = await handle.send(
        { id: 'msg_ship', text: 'ship it' },
        {
          origin: 'human',
          delivery: 'when-ready',
          onTranscriptItem: (item, harnessRef) => named.push([item, harnessRef]),
        },
      )
      const ref = [{ kind: 'grok-prompt', id: 'msg_ship' }]
      expect(receipt).toMatchObject({ outcome: 'accepted', harnessRef: ref })
      w.serverFor(handle.binding.sessionId).streamAgentText(['on it'])
      await expect.poll(() => named).toEqual([[{ id: 'grok-user-msg_ship' }, ref]])
    } finally {
      runtime.dispose()
    }
  })

  it('names the promptId it minted for a send with no id', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const receipt = await handle.send(
        { text: 'no id' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const promptId = (
        w.serverFor(handle.binding.sessionId).prompts.at(-1)?._meta as { promptId?: string }
      )?.promptId
      expect(receipt).toMatchObject({ harnessRef: [{ kind: 'grok-prompt', id: promptId }] })
    } finally {
      runtime.dispose()
    }
  })
})
