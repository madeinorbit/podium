/**
 * THE ORACLE'S OWN RULES, WITHOUT A SINGLE PROCESS (POD-4779).
 *
 * The delivery-outage lane is only as good as `violations()`: an oracle that
 * quietly stopped reporting a kind would turn every scenario that relies on it
 * green. Each rule is pinned here on a hand-built observation — the violating
 * shape AND its clean neighbour, so a rule that fires on everything fails too.
 */

import type { ConversationBubble, ConversationState } from '@podium/client-core/conversation'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  kindsOf,
  type Observation,
  type ServerRow,
  stormViolations,
  type TrackedMessage,
  violations,
} from './delivery-oracle'
import { bubblesOf, type MessageOnScreen } from './device'
import type { LinkFrame } from './link-proxy'

const S = 'session-1'
const ID = 'msg_00000000-0000-4000-8000-000000000001'
const OTHER = 'msg_00000000-0000-4000-8000-000000000002'
const text = (id: string): string => `[${id}] hello`

function observe(parts: Partial<Observation> & { messages: TrackedMessage[] }): Observation {
  return { typed: [], rows: [], devices: [], outboxes: new Map(), ...parts }
}

const sent = (expect: TrackedMessage['expect'] = 'delivered'): TrackedMessage => ({
  id: ID,
  sessionId: S,
  expect,
  sender: 'phone',
})
const typedOnce = [{ sessionId: S, prompt: text(ID), at: 1 }]
const row = (deliveryStatus: ServerRow['deliveryStatus'], id = ID): ServerRow => ({
  id,
  sessionId: S,
  body: text(ID),
  deliveryStatus,
})
const screen = (device: string, shown?: MessageOnScreen) => ({
  device,
  sessionId: S,
  screen: new Map(shown ? [[ID, shown]] : []),
})

describe('delivery oracle', () => {
  it('a message typed once, confirmed, drawn once everywhere is clean', () => {
    const found = violations(
      observe({
        messages: [sent()],
        typed: typedOnce,
        rows: [row('confirmed')],
        devices: [
          screen('phone', { bubbles: 1, shownAs: 'in-transcript' }),
          screen('laptop', { bubbles: 1, shownAs: 'in-transcript' }),
        ],
      }),
    )
    expect(found).toEqual([])
  })

  it('typed twice', () => {
    const found = violations(
      observe({
        messages: [sent()],
        typed: [...typedOnce, ...typedOnce],
        rows: [row('confirmed')],
      }),
    )
    expect(kindsOf(found)).toEqual(['typed-twice'])
  })

  it('a transient fault that ends a message unsent is a loss; a server that gave up on it is a loss', () => {
    expect(kindsOf(violations(observe({ messages: [sent()], rows: [row('failed')] })))).toEqual([
      'lost',
    ])
    const noRow = observe({
      messages: [sent()],
      outboxes: new Map([['phone', new Map([[ID, 'failed' as const]])]]),
    })
    expect(kindsOf(violations(noRow))).toEqual(['lost'])
    // …unless the device honestly could not reach the server for its whole window.
    expect(violations({ ...noRow, messages: [sent('delivered-or-not-sent')] })).toEqual([])
  })

  it('a message still on its way at rest is stuck', () => {
    expect(kindsOf(violations(observe({ messages: [sent()], rows: [row('dispatched')] })))).toEqual(
      ['stuck'],
    )
    expect(
      kindsOf(
        violations(observe({ messages: [sent()], typed: typedOnce, rows: [row('dispatched')] })),
      ),
    ).toEqual(['stuck'])
    const stillSending = observe({
      messages: [sent()],
      outboxes: new Map([['phone', new Map([[ID, 'sending' as const]])]]),
    })
    expect(kindsOf(violations(stillSending))).toEqual(['stuck'])
  })

  it('a status that contradicts what the agent received lies', () => {
    expect(
      kindsOf(violations(observe({ messages: [sent()], typed: typedOnce, rows: [row('failed')] }))),
    ).toEqual(['status-lies'])
    expect(kindsOf(violations(observe({ messages: [sent()], rows: [row('confirmed')] })))).toEqual([
      'status-lies',
    ])
  })

  it('unknown is allowed only in the declared ambiguous window', () => {
    expect(
      kindsOf(
        violations(observe({ messages: [sent()], typed: typedOnce, rows: [row('unknown')] })),
      ),
    ).toEqual(['unknown-outside-window'])
    expect(
      violations(
        observe({ messages: [sent('ambiguous')], typed: typedOnce, rows: [row('unknown')] }),
      ),
    ).toEqual([])
    expect(violations(observe({ messages: [sent('ambiguous')], rows: [row('unknown')] }))).toEqual(
      [],
    )
    expect(
      violations(
        observe({ messages: [sent('ambiguous')], typed: typedOnce, rows: [row('confirmed')] }),
      ),
    ).toEqual([])
    // The window allows not knowing — not being wrong.
    expect(
      kindsOf(
        violations(
          observe({ messages: [sent('ambiguous')], typed: typedOnce, rows: [row('failed')] }),
        ),
      ),
    ).toEqual(['status-lies'])
  })

  it('a retract wins only before typing, and says so either way', () => {
    expect(
      violations(observe({ messages: [sent('retracted')], rows: [row('cancelled')] })),
    ).toEqual([])
    expect(
      violations(
        observe({ messages: [sent('retracted')], typed: typedOnce, rows: [row('confirmed')] }),
      ),
    ).toEqual([])
    expect(
      kindsOf(
        violations(
          observe({ messages: [sent('retracted')], typed: typedOnce, rows: [row('cancelled')] }),
        ),
      ),
    ).toEqual(['status-lies'])
  })

  it('one message is one server row', () => {
    const copy: ServerRow = { id: OTHER, sessionId: S, body: text(ID), deliveryStatus: 'confirmed' }
    expect(
      kindsOf(
        violations(
          observe({ messages: [sent()], typed: typedOnce, rows: [row('confirmed'), copy] }),
        ),
      ),
    ).toEqual(['duplicate-row'])
    // Tracked by text (no id from the sender): the first row stands for it.
    const byText: TrackedMessage = { id: ID, sessionId: S, expect: 'delivered', trackedBy: 'text' }
    const first: ServerRow = {
      id: 'row-a',
      sessionId: S,
      body: text(ID),
      deliveryStatus: 'confirmed',
    }
    expect(violations(observe({ messages: [byText], typed: typedOnce, rows: [first] }))).toEqual([])
    expect(
      kindsOf(violations(observe({ messages: [byText], typed: typedOnce, rows: [first, copy] }))),
    ).toEqual(['duplicate-row'])
  })

  it('a prompt nobody sent is reported', () => {
    const found = violations(
      observe({
        messages: [sent()],
        typed: [...typedOnce, { sessionId: S, prompt: 'send it again', at: 2 }],
        rows: [row('confirmed')],
      }),
    )
    expect(kindsOf(found)).toEqual(['untracked-prompt'])
  })

  it('screens: one bubble each, telling the truth, the same story everywhere', () => {
    const base = { messages: [sent()], typed: typedOnce, rows: [row('confirmed')] }
    expect(
      kindsOf(
        violations(
          observe({
            ...base,
            devices: [screen('phone', { bubbles: 2, shownAs: 'in-transcript' })],
          }),
        ),
      ),
    ).toEqual(['duplicate-bubble'])
    expect(
      kindsOf(
        violations(
          observe({
            ...base,
            devices: [screen('phone', { bubbles: 1, shownAs: 'pending:sending' })],
          }),
        ),
      ),
    ).toEqual(['screen-lies'])
    expect(
      kindsOf(
        violations(
          observe({
            messages: [sent()],
            rows: [row('failed')],
            devices: [screen('phone', { bubbles: 1, shownAs: 'pending:failed' }), screen('laptop')],
          }),
        ),
      ),
    ).toEqual(['devices-disagree', 'lost'])
    // Sender "failed" and another device's failed record are the same story.
    expect(
      kindsOf(
        violations(
          observe({
            messages: [sent()],
            rows: [row('failed')],
            devices: [
              screen('phone', { bubbles: 1, shownAs: 'pending:failed' }),
              screen('laptop', { bubbles: 1, shownAs: 'pending:failed' }),
            ],
          }),
        ),
      ),
    ).toEqual(['lost'])
  })

  it('storm: delivery frames after a reconnect are bounded by the backlog', () => {
    const frame = (at: number): LinkFrame => ({
      dir: 'down',
      type: 'runtimeDurableSendRequest',
      at,
      conn: 2,
    })
    const frames = [frame(5), frame(10), frame(11), frame(12)]
    expect(stormViolations(frames, 10, { backlog: 1, perMessage: 3, fixed: 0 })).toEqual([])
    expect(kindsOf(stormViolations(frames, 10, { backlog: 1, perMessage: 2, fixed: 0 }))).toEqual([
      'storm',
    ])
    // Dropped frames never crossed, and upward frames are not delivery pushes.
    const quiet = [
      { ...frame(11), dropped: true },
      { ...frame(12), dir: 'up' as const },
    ]
    expect(stormViolations(quiet, 10, { backlog: 0, perMessage: 1, fixed: 0 })).toEqual([])
  })
})

describe('bubblesOf — what a chat surface draws', () => {
  const state = (bubbles: Partial<ConversationBubble>[]): ConversationState =>
    ({ bubbles }) as unknown as ConversationState
  const item = (id: string): TranscriptItem =>
    ({ id: `t-${id}`, role: 'user', text: text(id) }) as TranscriptItem

  it('a transcript entry and a bubble for the same message are two bubbles', () => {
    const drawn = bubblesOf(state([{ deliveryId: ID, state: 'failed' }]), [item(ID)])
    expect(drawn.get(ID)).toMatchObject({ bubbles: 2, shownAs: 'in-transcript' })
  })

  it('a bubble carries its error; a delivered message is one transcript bubble', () => {
    const drawn = bubblesOf(
      state([{ id: 'p', deliveryId: OTHER, state: 'failed', error: 'not sent' }]),
      [item(ID)],
    )
    expect(drawn.get(ID)).toEqual({ bubbles: 1, shownAs: 'in-transcript' })
    expect(drawn.get(OTHER)).toEqual({ bubbles: 1, shownAs: 'pending:failed', error: 'not sent' })
  })
})
