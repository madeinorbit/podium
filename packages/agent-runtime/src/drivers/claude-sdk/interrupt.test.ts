// What an operator is owed when they stop a turn, and what they used to get.
//
// The drive that produced this file interrupted a live Claude SDK turn. The turn
// stopped — and the transcript said nothing about it at all. A human reading the
// conversation back saw an answer that trailed off mid-sentence, which is what
// they would also have seen if the model had failed, been rate-limited, or
// simply lost the thread. The stop had happened and left no trace that it had.
//
// Underneath that were two silences, not one. The provider's answer to the
// interrupt was discarded, so a REFUSED interrupt and an honoured one arrived at
// the runtime as the same event: nothing. Every test here pins one of the four
// things that answer can be — honoured, refused, unconfirmed, or nothing to
// interrupt — to the record it must leave.

import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../index.js'
import {
  type ClaudeSdkInterruptAck,
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkTurnHandle,
  createClaudeSdkRuntime,
} from './runtime.js'

const SESSION = 'claude-sdk-interrupt' as SessionId
const RESUME = '00000000-0000-4000-8000-0000000000a1'

function spec() {
  return {
    harness: 'claude-code' as const,
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['claude-sdk' as const],
      preference: 'claude-sdk' as const,
    },
    workdir: '/tmp/claude-sdk-interrupt',
    model: {},
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
}

interface Turn {
  resolve(result: { resumeValue: string; output: string }): void
  reject(error: Error): void
  /** Interrupt requests that reached the child, acknowledged and otherwise. */
  asked: number
  /** Calls to the fire-and-forget teardown poke, counted separately: the two are
   *  different verbs and conflating them hides which one a path really used. */
  poked: number
}

function harness(options: {
  ack?: () => Promise<ClaudeSdkInterruptAck>
  /** Omit `requestInterrupt` entirely — a host with no confirmation channel. */
  unacknowledged?: boolean
}) {
  const turns: Turn[] = []
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => SESSION,
    mintResumeValue: () => RESUME,
    now: () => new Date(2026, 7, 28).toISOString(),
    startTurn(): ClaudeSdkTurnHandle {
      let resolve!: Turn['resolve']
      let reject!: Turn['reject']
      const done = new Promise<{ resumeValue: string; output: string }>((res, rej) => {
        resolve = res
        reject = rej
      })
      const turn: Turn = { resolve, reject, asked: 0, poked: 0 }
      turns.push(turn)
      const handle: ClaudeSdkTurnHandle = {
        done,
        interrupt() {
          turn.poked += 1
        },
        answerPermission() {},
        dispose() {},
      }
      if (!options.unacknowledged) {
        handle.requestInterrupt = async () => {
          turn.asked += 1
          return options.ack ? await options.ack() : { outcome: 'accepted' }
        }
      }
      return handle
    },
    async readTranscript() {
      return []
    },
    async readArchive() {
      return undefined
    },
  }
  return { host, turns }
}

/** Collect the live event stream into an array that keeps growing in the
 *  background, so assertions can watch for what a turn eventually published. */
function collect(runtime: ReturnType<typeof createClaudeSdkRuntime>): {
  events: RuntimeEvent[]
  items(): TranscriptItem[]
} {
  const handle = runtime.handleFor(SESSION)
  if (!handle) throw new Error('missing handle')
  const events: RuntimeEvent[] = []
  void (async () => {
    try {
      for await (const event of handle.events('bootstrap')) events.push(event)
    } catch {
      // The stream ends with the session; that is not a test failure.
    }
  })()
  return {
    events,
    items: () =>
      events.flatMap((e) => (e.t === 'item' && e.item.kind === 'complete' ? [e.item.item] : [])),
  }
}

const interruptItems = (items: TranscriptItem[]): TranscriptItem[] =>
  items.filter((item) => item.role === 'system' && /interrupt/i.test(item.text))

async function startedSession(options: Parameters<typeof harness>[0] = {}) {
  const { host, turns } = harness(options)
  const runtime = createClaudeSdkRuntime(host)
  const session = await runtime.createWithId(SESSION, spec())
  const stream = collect(runtime)
  const receipt = await session.send(
    { text: 'count to two hundred' },
    { origin: 'human', delivery: 'when-ready' },
  )
  expect(receipt.outcome, 'the fixture must actually open a turn to interrupt').toBe('accepted')
  return { runtime, session, turns, stream }
}

describe('Claude SDK interrupt receipt', () => {
  it('leaves exactly one durable interrupt record when a turn is stopped', async () => {
    const { session, turns, stream } = await startedSession({})

    await session.interrupt()
    expect(turns[0]?.asked, 'the interrupt must reach the provider').toBe(1)

    // The provider honoured it, so the wound-down stream reports what it had.
    turns[0]?.resolve({ resumeValue: RESUME, output: 'One. Two. Th' })

    await vi.waitFor(() => {
      expect(interruptItems(stream.items())).toHaveLength(1)
    })
    const record = interruptItems(stream.items())[0]
    expect(record?.text).toBe('Turn interrupted by the operator.')

    const closes = stream.events.filter((e) => e.t === 'turn' && e.ev.ev !== 'started')
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ t: 'turn', ev: { ev: 'completed', verdict: 'interrupted' } })
    expect((await session.state()).phase).not.toBe('working')
  })

  it('does not mint a second record when the operator interrupts twice', async () => {
    const { session, turns, stream } = await startedSession({})

    await Promise.all([session.interrupt(), session.interrupt()])
    expect(turns[0]?.asked).toBe(2)
    turns[0]?.resolve({ resumeValue: RESUME, output: 'One. Tw' })

    await vi.waitFor(() => {
      expect(interruptItems(stream.items())).toHaveLength(1)
    })
    // Settle anything still in flight, then prove nothing else arrived.
    await new Promise((r) => setTimeout(r, 10))
    expect(interruptItems(stream.items()), 'one stop is one record').toHaveLength(1)
  })

  it('says why when the provider refuses, and lets the turn finish as itself', async () => {
    const { session, turns, stream } = await startedSession({
      ack: async () => ({ outcome: 'rejected', detail: 'stream already closed.' }),
    })

    await session.interrupt()

    await vi.waitFor(() => {
      expect(interruptItems(stream.items()), 'a refused interrupt is still a receipt').toHaveLength(
        1,
      )
    })
    const refusal = interruptItems(stream.items())
    expect(refusal[0]?.text).toContain('stream already closed.')
    expect(refusal[0]?.text).toContain('still running')
    expect(
      stream.events.some((e) => e.t === 'turn' && e.ev.ev !== 'started'),
      'a refused interrupt must not close the turn it failed to stop',
    ).toBe(false)

    // LATE COMPLETION FENCING. The turn the provider declined to stop goes on to
    // finish. It must be reported as the completion it is — reporting it as an
    // interruption would tell the operator their stop worked when it did not.
    turns[0]?.resolve({ resumeValue: RESUME, output: 'One. Two. ... Two hundred.' })
    await vi.waitFor(() => {
      expect(stream.events.some((e) => e.t === 'turn' && e.ev.ev === 'completed')).toBe(true)
    })
    const close = stream.events.find((e) => e.t === 'turn' && e.ev.ev === 'completed')
    expect(close).toMatchObject({ ev: { ev: 'completed', verdict: 'done' } })
    expect(interruptItems(stream.items()), 'no stop happened, so no stop record').toHaveLength(1)
  })

  it('records an unconfirmed stop as unconfirmed rather than as a clean one', async () => {
    const { session, turns, stream } = await startedSession({
      ack: async () => ({ outcome: 'unconfirmed', detail: 'the host exited' }),
    })

    await session.interrupt()
    // The host died: the turn fails rather than winding down politely.
    turns[0]?.reject(new Error('the Claude model host process exited on SIGKILL'))

    await vi.waitFor(() => {
      expect(interruptItems(stream.items())).toHaveLength(1)
    })
    expect(interruptItems(stream.items())[0]?.text).toContain('did not confirm')

    const failed = stream.events.find((e) => e.t === 'turn' && e.ev.ev === 'failed')
    expect(failed, 'an interrupted turn still closes as interrupted').toMatchObject({
      ev: { ev: 'failed', reason: 'interrupted' },
    })
  })

  it('treats a host with no confirmation channel as unconfirmed, never as accepted', async () => {
    const { session, turns, stream } = await startedSession({ unacknowledged: true })

    await session.interrupt()
    expect(turns[0]?.poked, 'the fallback still asks the child to stop').toBe(1)
    turns[0]?.resolve({ resumeValue: RESUME, output: 'One. Tw' })

    await vi.waitFor(() => {
      expect(interruptItems(stream.items())).toHaveLength(1)
    })
    expect(interruptItems(stream.items())[0]?.text).toContain('did not confirm')
  })

  it('answers an interrupt with nothing to interrupt, once per turn', async () => {
    const { host } = harness({})
    const runtime = createClaudeSdkRuntime(host)
    const session = await runtime.createWithId(SESSION, spec())
    const stream = collect(runtime)

    await session.interrupt()
    await session.interrupt()

    await vi.waitFor(() => {
      expect(interruptItems(stream.items()), 'silence read as a stop that had worked').toHaveLength(
        1,
      )
    })
    // Settle, then prove the second press added nothing.
    await new Promise((r) => setTimeout(r, 10))
    const items = interruptItems(stream.items())
    expect(items, 'one receipt per turn, however often the button is pressed').toHaveLength(1)
    expect(items[0]?.text).toBe('Interrupt refused: no turn was in flight.')
  })
})
