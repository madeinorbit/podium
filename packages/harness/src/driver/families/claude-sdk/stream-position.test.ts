// A Claude SDK session's event stream across daemon lives (POD-6280).
//
// After a daemon restart the journal adoption resumes a fresh core under the
// same segment. It used to start again at ordinal 1, epoch 0, generation 1, so
// the server's gate read the new life as a replay of the old one: every event
// a silent duplicate until the ordinal passed the old one, then
// `turn-epoch-jump` for the rest of the session, its turn ends never recorded
// (the session read Working forever). The gate's protocol for a new life is the
// next generation, opening with a bootstrap, numbered after the old life.

import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../../host.js'
import { testHarnessContext } from '../../testing/harness-context.js'
import { createMemoryAttachmentStager, createMemoryDriverSlots } from '../../testing/index.js'
import {
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkStreamPosition,
  type ClaudeSdkTurnHandle,
  createClaudeSdkRuntime,
} from './runtime.js'

const SESSION = 'claude-sdk-lives' as SessionId
const RESUME = '00000000-0000-4000-8000-0000000000cc'

function spec() {
  return {
    harness: 'claude-code' as const,
    harnessContext: testHarnessContext({ kind: 'claude-code' }),
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['claude-sdk' as const],
      preference: 'claude-sdk' as const,
    },
    workdir: '/tmp/claude-sdk-lives',
    model: {},
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
}

/** One daemon life over a journal that outlives it. Turns never end. */
function life(journal: Map<SessionId, ClaudeSdkStreamPosition>) {
  const host: ClaudeSdkRuntimeHost = {
    stageAttachment: createMemoryAttachmentStager(),
    mintSessionId: () => SESSION,
    mintResumeValue: () => RESUME,
    now: () => '2026-11-03T12:00:00.000Z',
    startTurn(): ClaudeSdkTurnHandle {
      return {
        done: new Promise(() => {}),
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
      return undefined
    },
    streamPosition: {
      recorded: (sessionId) => journal.get(sessionId),
      record: (sessionId, position) => journal.set(sessionId, position),
    },
  }
  return createClaudeSdkRuntime(host, createMemoryDriverSlots())
}

async function eventsUntil(
  handle: { events(from: 'bootstrap'): AsyncIterable<RuntimeEvent> },
  done: (events: RuntimeEvent[]) => boolean,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of handle.events('bootstrap')) {
    events.push(event)
    if (done(events)) break
  }
  return events
}

const started = (epoch: number) => (events: RuntimeEvent[]) =>
  events.some((e) => e.t === 'turn' && e.ev.ev === 'started' && e.turnEpoch === epoch)

describe('a Claude SDK stream across daemon lives', () => {
  it('opens the next life as the next generation, numbered after the last', async () => {
    const journal = new Map<SessionId, ClaudeSdkStreamPosition>()
    const first = life(journal)
    const a = await first.createWithId(SESSION, spec())
    await a.send({ id: 't1', text: 'long task' }, { origin: 'human', delivery: 'when-ready' })
    const lifeA = await eventsUntil(a, started(1))
    const lastA = lifeA.at(-1)!
    first.dispose()

    // The restarted daemon's journal adoption resumes the same session id.
    const second = life(journal)
    const b = await second.resumeWithId(SESSION, { kind: 'claude-session', value: RESUME }, spec())
    await b.send(
      { id: 't2', text: 'after the restart' },
      { origin: 'human', delivery: 'when-ready' },
    )
    const lifeB = await eventsUntil(b, started(2))

    const opening = lifeB[0]!
    expect(opening.provenance).toBe('bootstrap')
    expect(opening.observerGeneration).toBe(lastA.observerGeneration + 1)
    expect(opening.turnEpoch).toBe(lastA.turnEpoch)
    expect(opening.cursor.segmentId).toBe(lastA.cursor.segmentId)
    // Every event of the new life is numbered after the old life's last.
    const lastSeq = Number(lastA.cursor.components.seq)
    expect(lifeB.every((e) => Number(e.cursor.components.seq) > lastSeq)).toBe(true)
    // And its next turn is the next epoch, not epoch 1 again.
    expect(lifeB.find((e) => e.t === 'turn' && e.ev.ev === 'started')?.turnEpoch).toBe(2)
    second.dispose()
  })

  it('keeps the numbering when a hibernated session wakes in the same daemon', async () => {
    const journal = new Map<SessionId, ClaudeSdkStreamPosition>()
    const runtime = life(journal)
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'first' }, { origin: 'human', delivery: 'when-ready' })
    const before = await eventsUntil(handle, started(1))
    const lastSeq = Number(before.at(-1)!.cursor.components.seq)
    const binding = handle.binding
    await handle.hibernate()
    journal.clear() // the wake must not depend on the journal within one daemon life
    const woken = await runtime.adopt(binding)
    const after = await eventsUntil(woken, (events) => events.length >= 2)
    expect(after.every((e) => Number(e.cursor.components.seq) > lastSeq)).toBe(true)
    expect(after[0]!.observerGeneration).toBe(before.at(-1)!.observerGeneration + 1)
    runtime.dispose()
  })
})
