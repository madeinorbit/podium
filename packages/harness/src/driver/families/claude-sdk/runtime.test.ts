import type { SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../host.js'
import {
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkTurnHandle,
  type ClaudeSdkTurnResult,
  createClaudeSdkRuntime,
} from './runtime.js'
import { claudeUserMessageUuid } from './message-uuid.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { RequestNotSentError } from '../../errors.js'

const SESSION = 'claude-sdk-durable' as SessionId

function spec() {
  return {
    harness: 'claude-code' as const,
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['claude-sdk' as const],
      preference: 'claude-sdk' as const,
    },
    workdir: '/tmp/claude-sdk-durable',
    model: {},
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
}

function hostWith(fail: (message: string) => Error): {
  host: ClaudeSdkRuntimeHost
  resumeValue: string
} {
  const resumeValue = '00000000-0000-4000-8000-000000000001'
  let archive = ''
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => SESSION,
    mintResumeValue: () => resumeValue,
    now: () => '2026-08-28T00:00:00.000Z',
    startTurn(input): ClaudeSdkTurnHandle {
      // The CLI took the line; the turn then failed.
      archive += `${JSON.stringify({
        type: 'user',
        uuid: input.userMessageUuid,
        sessionId: input.resumeValue,
        message: { role: 'user', content: input.turn.text },
        timestamp: host.now(),
      })}\n`
      const done = Promise.reject(fail('turn'))
      done.catch(() => {})
      return {
        done,
        accepted: Promise.resolve(),
        interrupt() {},
        answerPermission() {},
        dispose() {},
      }
    },
    async readTranscript() {
      return { items: [], hasMore: false }
    },
    async readArchive() {
      return { path: `${resumeValue}.jsonl`, bytes: new TextEncoder().encode(archive) }
    },
  }
  return { host, resumeValue }
}

async function settledState(runtime: ReturnType<typeof createClaudeSdkRuntime>) {
  const handle = runtime.handleFor(SESSION)
  if (!handle) throw new Error('missing handle')
  await vi.waitFor(async () => {
    const state = await handle.state()
    expect(state.phase).toBe('errored')
  })
  return handle
}

async function eventsThroughFailed(
  runtime: ReturnType<typeof createClaudeSdkRuntime>,
): Promise<RuntimeEvent[]> {
  const handle = await settledState(runtime)
  const events: RuntimeEvent[] = []
  for await (const event of handle.events('bootstrap')) {
    events.push(event)
    if (
      events.some((seen) => seen.t === 'turn' && seen.ev.ev === 'failed') &&
      events.some(
        (seen) =>
          seen.t === 'item' && seen.item.kind === 'complete' && seen.item.item.role === 'user',
      )
    )
      break
  }
  return events
}

describe('Claude SDK durable failure state', () => {
  it('records monthly spend as usage_limit and keeps the resume binding', async () => {
    const { host, resumeValue } = hostWith(
      () => new Error("You've hit your monthly spend limit CLAUDE_CODE_OAUTH_TOKEN=oat_secret"),
    )
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const settled = await settledState(runtime)
    await expect(settled.state()).resolves.toMatchObject({
      phase: 'errored',
      error: {
        class: 'usage_limit',
        retryable: false,
        detail: expect.stringMatching(/monthly spend limit/i),
      },
    })
    const state = await settled.state()
    expect(state.error?.detail).not.toMatch(/oat_secret/)
    expect(settled.binding.resume).toEqual({ kind: 'claude-session', value: resumeValue })
    runtime.dispose()
  })

  it('records expired auth as authentication, distinct from spend exhaustion', async () => {
    const { host } = hostWith(() => new Error('401 Unauthorized — access token is expired'))
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const settled = await settledState(runtime)
    await expect(settled.state()).resolves.toMatchObject({
      phase: 'errored',
      error: { class: 'authentication', retryable: false },
    })
    runtime.dispose()
  })

  it('records a dead SDK host as host_death, distinct from auth and quota', async () => {
    const { host } = hostWith(
      () => new Error('the Claude model host process exited with code 1 before the turn finished'),
    )
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const settled = await settledState(runtime)
    await expect(settled.state()).resolves.toMatchObject({
      phase: 'errored',
      error: { class: 'host_death', retryable: true },
    })
    runtime.dispose()
  })

  it('publishes the classified error before closing the turn and the prompt once read from disk', async () => {
    const { host } = hostWith(() => new Error('not logged in — run /login'))
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const events = await eventsThroughFailed(runtime)
    const kinds: string[] = []
    const items: { role: string; text: string }[] = []
    for (const event of events) {
      if (event.t === 'turn' && (event.ev.ev === 'failed' || event.ev.ev === 'started')) {
        kinds.push(`turn:${event.ev.ev}`)
        continue
      }
      if (event.t === 'state' && event.change.kind === 'turn_failed') {
        kinds.push('state:turn_failed')
        continue
      }
      if (event.t === 'item' && event.item.kind === 'complete') {
        kinds.push(`item:${event.item.item.role}`)
        items.push(event.item.item)
      }
    }
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'ping' }),
        expect.objectContaining({
          role: 'system',
          text: expect.stringMatching(/Provider authentication failed/i),
        }),
      ]),
    )
    expect(items).toHaveLength(2)
    expect(kinds.indexOf('state:turn_failed')).toBeLessThan(kinds.indexOf('turn:failed'))
    expect(kinds.indexOf('item:system')).toBeLessThan(kinds.indexOf('turn:failed'))
    const failed = events.find(
      (event) => event.t === 'state' && event.change.kind === 'turn_failed',
    )
    expect(failed).toMatchObject({
      t: 'state',
      change: { kind: 'turn_failed', errorClass: 'authentication', retryable: false },
    })
    runtime.dispose()
  })
})

/** A host whose turns the test settles by hand: the CLI's ack of the line,
 *  then the turn's end. */
function manualHost(): {
  host: ClaudeSdkRuntimeHost
  started: string[]
  turns: Array<{
    ack(): void
    refuse(error: Error): void
    finish(result?: Partial<ClaudeSdkTurnResult>): void
    fail(error: Error): void
    interrupts: number
  }>
} {
  const started: string[] = []
  const turns: ReturnType<typeof manualHost>['turns'] = []
  const { host } = hostWith(() => new Error('unused'))
  let archive = ''
  return {
    started,
    turns,
    host: {
      ...host,
      async readArchive() {
        return { path: 'fixture.jsonl', bytes: new TextEncoder().encode(archive) }
      },
      startTurn(input): ClaudeSdkTurnHandle {
        started.push(input.userMessageUuid)
        let ack!: () => void
        let refuse!: (error: Error) => void
        const accepted = new Promise<void>((res, rej) => {
          ack = res
          refuse = rej
        })
        accepted.catch(() => {})
        let finish!: (value: ClaudeSdkTurnResult) => void
        let fail!: (error: Error) => void
        const done = new Promise<ClaudeSdkTurnResult>((res, rej) => {
          finish = res
          fail = rej
        })
        done.catch(() => {})
        const turn: ReturnType<typeof manualHost>['turns'][number] = {
          ack: () => {
            archive += `${JSON.stringify({
              type: 'user',
              uuid: input.userMessageUuid,
              sessionId: input.resumeValue,
              message: { role: 'user', content: input.turn.text },
              timestamp: host.now(),
            })}\n`
            ack()
          },
          refuse: (error) => {
            refuse(error)
            fail(error)
          },
          finish: (result = {}) => finish({ resumeValue: 'resume-1', output: '', ...result }),
          fail,
          interrupts: 0,
        }
        turns.push(turn)
        return {
          done,
          accepted,
          interrupt() {},
          async requestInterrupt() {
            turn.interrupts += 1
            return { outcome: 'accepted' as const }
          },
          answerPermission() {},
          dispose() {},
        }
      },
    },
  }
}

const pending = Symbol('pending')
async function settled<T>(promise: Promise<T>): Promise<T | typeof pending> {
  return Promise.race([
    promise,
    new Promise<typeof pending>((res) => setTimeout(() => res(pending), 0)),
  ])
}

async function eventsUntil(
  handle: { events(cursor: 'bootstrap'): AsyncIterable<RuntimeEvent> },
  done: (events: readonly RuntimeEvent[]) => boolean,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of handle.events('bootstrap')) {
    events.push(event)
    if (done(events)) break
  }
  return events
}

const userItemIds = (events: readonly RuntimeEvent[]): string[] =>
  events.flatMap((event) =>
    event.t === 'item' && event.item.kind === 'complete' && event.item.item.role === 'user'
      ? [event.item.item.id]
      : [],
  )
const turnEvents = (events: readonly RuntimeEvent[]): string[] =>
  events.flatMap((event) => (event.t === 'turn' ? [event.ev.ev] : []))

describe('the history entry a delivered send became (POD-4774, POD-4836)', () => {
  const MESSAGE = 'msg_0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e70'
  const ENTRY = '0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e70'

  it('types the line under the uuid derived from the message id, and reports that entry', async () => {
    const { host, started, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const receipt = handle.send(
      { id: MESSAGE, text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.ack()
    await expect(receipt).resolves.toMatchObject({
      outcome: 'accepted',
      provenBy: 'protocol-ack',
      held: 'memory',
    })
    expect(started).toEqual([ENTRY])
    // The id the chat shows for the prompt.
    const events = await eventsUntil(handle, (seen) => userItemIds(seen).length > 0)
    expect(userItemIds(events)).toEqual([ENTRY])
    runtime.dispose()
  })

  it('names the same entry on every attempt at the same message', async () => {
    const { host, started, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const first = handle.send(
      { id: 'notice:4720:7', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.refuse(
      new Error('the Claude model host process exited with code 1 before the turn finished'),
    )
    // Unproven (POD-4839); a resend under the same uuid is what Claude skips
    // when it already holds the line.
    await expect(first).rejects.toThrow(/exited with code 1/)
    const again = handle.send(
      { id: 'notice:4720:7', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]!.ack()
    await expect(again).resolves.toMatchObject({ outcome: 'accepted' })
    expect(started).toEqual([
      claudeUserMessageUuid('notice:4720:7'),
      claudeUserMessageUuid('notice:4720:7'),
    ])
    runtime.dispose()
  })

  it("carries the entry on a durable row's delivered outcome", async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send(
      { id: 'row-1', text: 'durable ping', rowId: 'row-1' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.ack()
    const events = await eventsUntil(handle, (seen) => seen.some((event) => event.t === 'delivery'))
    expect(events.find((event) => event.t === 'delivery')).toMatchObject({
      t: 'delivery',
      rowId: 'row-1',
      outcome: 'delivered',
      transcriptItem: { id: claudeUserMessageUuid('row-1') },
    })
    expect(userItemIds(events)).toEqual([claudeUserMessageUuid('row-1')])
    runtime.dispose()
  })
})

describe("Claude's own id for our message (POD-4841)", () => {
  it('names the uuid the line was typed under, on the receipt and on the outcome', async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const uuid = claudeUserMessageUuid('msg_direct')
    const receipt = handle.send(
      { id: 'msg_direct', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]?.ack()
    await expect(receipt).resolves.toMatchObject({
      outcome: 'accepted',
      harnessRef: [{ kind: 'claude-uuid', id: uuid }],
    })
    runtime.dispose()

    const durable = manualHost()
    const rowRuntime = createClaudeSdkRuntime(durable.host, createMemoryDriverSlots())
    const rowHandle = await rowRuntime.createWithId(SESSION, spec())
    await rowHandle.send(
      { id: 'row-1', text: 'durable ping', rowId: 'row-1' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(durable.turns).toHaveLength(1))
    durable.turns[0]?.ack()
    const events = await eventsUntil(rowHandle, (seen) =>
      seen.some((event) => event.t === 'delivery'),
    )
    expect(events.find((event) => event.t === 'delivery')).toMatchObject({
      rowId: 'row-1',
      harnessRef: [{ kind: 'claude-uuid', id: claudeUserMessageUuid('row-1') }],
    })
    rowRuntime.dispose()
  })
})

describe('the receipt waits for the CLI to acknowledge the line (POD-4836)', () => {
  it('is not accepted, and opens no turn, until the CLI acks the line', async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const receipt = handle.send(
      { id: 'm1', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(await settled(receipt)).toBe(pending)
    expect(await handle.state()).toMatchObject({ phase: 'idle' })
    turns[0]!.ack()
    await expect(receipt).resolves.toMatchObject({ outcome: 'accepted', turnEpoch: 1 })
    expect(await handle.state()).toMatchObject({ phase: 'working' })
    runtime.dispose()
  })

  it('refuses a line that was never written, with no turn and no prompt on the transcript', async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const receipt = handle.send(
      { id: 'm1', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.refuse(new RequestNotSentError('the Claude stream client is closed'))
    await expect(receipt).resolves.toEqual({
      outcome: 'refused',
      refusal: { reason: 'not_running', detail: 'the Claude stream client is closed' },
    })
    // The session is free again, and nothing claims a turn ran.
    const next = handle.send(
      { id: 'm2', text: 'pong' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]!.ack()
    await expect(next).resolves.toMatchObject({ outcome: 'accepted', turnEpoch: 1 })
    const events = await eventsUntil(handle, (seen) => userItemIds(seen).length > 0)
    expect(turnEvents(events)).toEqual(['started'])
    expect(userItemIds(events)).toEqual([claudeUserMessageUuid('m2')])
    runtime.dispose()
  })

  it('never refuses a written line the CLI did not ack: the CLI may have recorded it (POD-4839)', async () => {
    // A line on the CLI's stdin may be in the transcript whatever ends the turn
    // before the ack: the process exiting, an error result (an HTTP 400 left
    // the prompt recorded, POD-4834). Unproven, never a "no".
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const receipt = handle.send(
      { id: 'm1', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]?.refuse(
      new Error('the Claude model host process exited with code 1 before the turn finished'),
    )
    await expect(receipt).rejects.toThrow(/exited with code 1/)
    // The session is free again for the next line.
    const next = handle.send(
      { id: 'm2', text: 'pong' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]?.ack()
    await expect(next).resolves.toMatchObject({ outcome: 'accepted' })
    runtime.dispose()
  })

  it('accepts a line the session already held, and closes the turn it opens without running one', async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const receipt = handle.send(
      { id: 'm1', text: 'ping' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    // What the protocol does with a skipped line: acked, and the turn ends
    // empty at once — no `result` will ever come for it.
    turns[0]!.ack()
    turns[0]!.finish()
    await expect(receipt).resolves.toMatchObject({
      outcome: 'accepted',
      held: 'memory',
    })
    const events = await eventsUntil(handle, (seen) => turnEvents(seen).includes('completed'))
    expect(turnEvents(events)).toEqual(['started', 'completed'])
    expect(
      events.some(
        (event) =>
          event.t === 'item' &&
          event.item.kind === 'complete' &&
          event.item.item.role === 'assistant',
      ),
    ).toBe(false)
    runtime.dispose()
  })

  it('queues a send that arrives while a line waits for its ack', async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    const first = handle.send(
      { id: 'm1', text: 'one' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    await expect(
      handle.send({ id: 'm2', text: 'two' }, { origin: 'human', delivery: 'when-ready' }),
    ).resolves.toMatchObject({ outcome: 'queued', position: 1 })
    await expect(
      handle.send(
        { id: 'm3', text: 'three' },
        { origin: 'human', delivery: 'when-ready', deliveryAttempt: true },
      ),
    ).resolves.toEqual({ outcome: 'refused', refusal: { reason: 'busy' } })
    expect(turns).toHaveLength(1)
    turns[0]!.ack()
    await expect(first).resolves.toMatchObject({ outcome: 'accepted' })
    turns[0]!.finish()
    // The queued line goes out at the boundary.
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    runtime.dispose()
  })

  it('an interrupt while the line waits for its ack stops the turn the ack opens', async () => {
    const { host, turns } = manualHost()
    const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
    const handle = await runtime.createWithId(SESSION, spec())
    void handle.send({ id: 'm1', text: 'one' }, { origin: 'human', delivery: 'when-ready' })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    const interrupted = handle.interrupt()
    expect(await settled(interrupted)).toBe(pending)
    expect(turns[0]!.interrupts).toBe(0)
    turns[0]!.ack()
    await interrupted
    expect(turns[0]!.interrupts).toBe(1)
    runtime.dispose()
  })
})
