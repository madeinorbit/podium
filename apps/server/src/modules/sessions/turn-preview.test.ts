/**
 * THE PREVIEW FOLD (POD-2293).
 *
 * Every property here is one of the three rules in `./turn-preview.ts`, or the
 * coalescing that makes the plane affordable. The fake clock is not a
 * convenience: the whole point of the accumulator is WHEN it publishes, and a
 * test that measured only what it published would pass on an implementation that
 * sent one frame per token.
 */

import type { SessionId, TranscriptItem } from '@podium/model'
import type { RuntimeEvent, TurnPreviewMessage } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { TurnPreviewAccumulator } from './turn-preview'

const SESSION = 'sess-preview' as SessionId

interface World {
  fold: TurnPreviewAccumulator
  sent: TurnPreviewMessage[]
  tick(ms: number): void
  at(): number
}

function world(): World {
  let now = 1_000
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextTimer = 1
  const sent: TurnPreviewMessage[] = []
  const fold = new TurnPreviewAccumulator({
    publish: (_sessionId, frame) => sent.push(frame),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.push({ at: now + ms, fn, id })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((t) => t.id === (handle as unknown as number))
      if (index >= 0) timers.splice(index, 1)
    },
  })
  return {
    fold,
    sent,
    at: () => now,
    tick(ms) {
      now += ms
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
    },
  }
}

let seq = 0
const envelope = (turnEpoch: number): Omit<RuntimeEvent, 't'> =>
  ({
    at: new Date(1_786_700_000_000 + ++seq).toISOString(),
    provenance: 'live',
    cursor: { segmentId: 'seg', components: { seq } },
    observerGeneration: 1,
    turnEpoch,
  }) as Omit<RuntimeEvent, 't'>

const delta = (turnEpoch: number, itemId: string, textDelta: string): RuntimeEvent =>
  ({
    ...envelope(turnEpoch),
    t: 'item',
    item: { kind: 'delta', itemId, textDelta },
  }) as RuntimeEvent

const partial = (turnEpoch: number, item: TranscriptItem): RuntimeEvent =>
  ({ ...envelope(turnEpoch), t: 'item', item: { kind: 'partial', item } }) as RuntimeEvent

const complete = (turnEpoch: number, item: TranscriptItem): RuntimeEvent =>
  ({ ...envelope(turnEpoch), t: 'item', item: { kind: 'complete', item } }) as RuntimeEvent

const turnEnd = (turnEpoch: number, ev: 'completed' | 'failed' = 'completed'): RuntimeEvent =>
  ({
    ...envelope(turnEpoch),
    t: 'turn',
    ev:
      ev === 'completed'
        ? { ev, turnEpoch, verdict: 'done' }
        : { ev, turnEpoch, reason: 'provider-error' },
  }) as RuntimeEvent

const toolItem = (id: string): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: 'sleep 120',
  toolUseId: id,
})

describe('turn preview — coalescing', () => {
  beforeEach(() => {
    seq = 0
  })

  it('publishes the FIRST fragment immediately, then at most one frame per window', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'He'))
    // The leading edge. A reply that took 100 ms to start appearing would read as
    // latency the streaming was supposed to remove.
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]?.items).toEqual([{ kind: 'text', itemId: 'a', text: 'He' }])

    for (const chunk of ['l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd']) {
      w.fold.record(SESSION, delta(1, 'a', chunk))
    }
    // Nine more fragments inside the window produced no further frames.
    expect(w.sent).toHaveLength(1)

    w.tick(100)
    expect(w.sent).toHaveLength(2)
    // And the trailing frame carries ALL of them — the snapshot is why skipping
    // the intermediate ones costs nothing.
    expect(w.sent[1]?.items).toEqual([{ kind: 'text', itemId: 'a', text: 'Hello world' }])
  })

  it('does not publish a trailing frame when nothing changed inside the window', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'x'))
    expect(w.sent).toHaveLength(1)
    w.tick(1000)
    expect(w.sent).toHaveLength(1)
  })
})

describe('turn preview — the three rules', () => {
  beforeEach(() => {
    seq = 0
  })

  it('retires a row when the durable item carrying its identity lands', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'msg_1', 'pong'))
    expect(w.sent.at(-1)?.items).toHaveLength(1)

    // The item the fragments were building. `streamItemIdOf` reads `id` for an
    // uncursored item, which is the identity the fragments carried.
    w.fold.record(SESSION, complete(1, { id: 'msg_1', role: 'assistant', text: 'pong' }))
    w.tick(100)
    // RULE 1: replaced, not merged and not left beside it. A preview row that
    // survived here is the duplicate reply a user would notice.
    expect(w.sent.at(-1)?.items).toEqual([])
  })

  it('keeps a row the durable item did NOT supersede', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'msg_1', 'writing'))
    w.fold.record(SESSION, partial(1, toolItem('cmd_1')))
    w.tick(100)
    expect(w.sent.at(-1)?.items).toHaveLength(2)

    w.fold.record(SESSION, complete(1, { id: 'cmd_1', role: 'tool', text: '', toolName: 'Bash' }))
    w.tick(100)
    expect(w.sent.at(-1)?.items).toEqual([{ kind: 'text', itemId: 'msg_1', text: 'writing' }])
  })

  it('clears the preview the instant the turn fences, without waiting for a window', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'half a rep'))
    const before = w.sent.length
    w.fold.record(SESSION, turnEnd(1))
    // NOT COALESCED. A preview that lingers past its turn shows a session still
    // typing under a reply that is already complete.
    expect(w.sent).toHaveLength(before + 1)
    expect(w.sent.at(-1)).toMatchObject({ done: true, items: [] })
  })

  it('reports a FAILED turn as done too — how it ended is the transcript’s business', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'partial'))
    w.fold.record(SESSION, turnEnd(1, 'failed'))
    expect(w.sent.at(-1)).toMatchObject({ done: true, items: [] })
  })

  it('never reopens a fenced epoch', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'first'))
    w.fold.record(SESSION, turnEnd(1))
    const after = w.sent.length
    // RULE 2. A fragment for epoch 1 now is a late arrival whose preview was
    // already replaced by the durable item.
    w.fold.record(SESSION, delta(1, 'a', ' more'))
    w.tick(1000)
    expect(w.sent).toHaveLength(after)
    expect(w.fold.retained(SESSION)).toBeUndefined()
  })

  it('starts clean on the next epoch rather than carrying rows across', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'old turn'))
    w.fold.record(SESSION, turnEnd(1))
    w.tick(100)
    w.fold.record(SESSION, delta(2, 'b', 'new turn'))
    expect(w.sent.at(-1)).toMatchObject({
      turnEpoch: 2,
      items: [{ kind: 'text', itemId: 'b', text: 'new turn' }],
    })
  })
})

describe('turn preview — replay and teardown', () => {
  beforeEach(() => {
    seq = 0
  })

  it('hands a late subscriber the current preview, and nothing once it is empty', () => {
    const w = world()
    expect(w.fold.retained(SESSION)).toBeUndefined()
    w.fold.record(SESSION, delta(1, 'a', 'mid-turn'))
    expect(w.fold.retained(SESSION)).toMatchObject({
      turnEpoch: 1,
      items: [{ kind: 'text', itemId: 'a', text: 'mid-turn' }],
    })
    w.fold.record(SESSION, turnEnd(1))
    expect(w.fold.retained(SESSION)).toBeUndefined()
  })

  it('forgets a session outright — its epoch numbering may not survive a rebind', () => {
    const w = world()
    w.fold.record(SESSION, delta(1, 'a', 'x'))
    w.fold.forget(SESSION)
    expect(w.fold.retained(SESSION)).toBeUndefined()
    const after = w.sent.length
    // Any timer the fold had must have gone with it: a coalescing flush landing
    // after teardown publishes into a session that is not there.
    w.tick(1000)
    expect(w.sent).toHaveLength(after)
  })
})
