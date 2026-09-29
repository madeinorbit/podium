/**
 * CHARACTERIZATION — an interrupt and a send with files are durable rows
 * [POD-4795], and a synchronous refusal ends only what it must [POD-2574].
 *
 * Every agent send is one row in the session's durable queue, under the
 * message id the daemon dedupes by; `interrupt` is that row's delivery mode and
 * staged files travel on it. The receipt a push hears is therefore the queue's
 * own answer, given at once — `queued`, or the refusal that kept the row out —
 * and what happened at the agent arrives later as the daemon's outcome for the
 * row, by id (`onQueuedInputApplied`, `onQueuedInputUnknown`, a drain
 * rejection). There is no direct push left for a later receipt to confirm or
 * correct, so nothing here reads a driver's `accepted`, `busy` or
 * `not_running`: that was the refusal-correction table this issue deleted.
 *
 * The properties this file holds down:
 *   - an interrupt is handed on as the interrupt mode of the durable row and is
 *     never `delivered` before the daemon says so;
 *   - a send with files is a row like any other, files and all;
 *   - the daemon's outcome settles the row once, and an `unknown` is never a
 *     failure or a resend;
 *   - a refusal of files that can never clear ends the row, stamped and quiet.
 */

import { asSessionId } from '@podium/model'
import type { TurnReceipt } from '@podium/protocol/daemon'
import { RefusalReason } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import { mailHarness } from './characterization-support'

const TARGET = asSessionId('sTarget')

const refused = (reason: RefusalReason, detail?: string): TurnReceipt => ({
  outcome: 'refused',
  refusal: { reason, ...(detail ? { detail } : {}) },
})

/** A staged attachment ref, minted by runtime staging rather than typed. */
const SHOT = {
  id: 'att_1',
  path: '/staged/shot.png',
  filename: 'shot.png',
  mediaType: 'image/png',
  kind: 'image' as const,
}

const liveTarget = async () => {
  const h = await mailHarness({ receipts: {} })
  const iss = await h.createIssue({ title: 'target' })
  h.put({ sessionId: TARGET, issueId: iss.id, phase: 'working' })
  return h
}

/** An operator INTERRUPT line: unwrapped, so no envelope can ever echo it —
 *  only the daemon's outcome for its row can confirm it. */
const interrupt = async (h: Awaited<ReturnType<typeof mailHarness>>, body: string) =>
  (await h.gate.dispatch(OPERATOR, undefined, 'send', {
    to: TARGET,
    body,
    urgency: 'interrupt',
  })) as { id: string }

/** Every undelivered-notice the sender was actually handed. */
const notices = async (h: Awaited<ReturnType<typeof mailHarness>>): Promise<string[]> =>
  (await h.store.messages.listMessagesFor({ kind: 'operator' }))
    .filter((m) => m.kind === 'notification' && m.fromKind === 'system')
    .map((m) => m.body)

const transitions = async (
  h: Awaited<ReturnType<typeof mailHarness>>,
  kind: string,
  id: string,
) => (await h.events([kind])).filter((e) => e.subject === id)

describe('an interrupt is the interrupt mode of one durable row (POD-4795)', () => {
  it('is handed on as queued, never delivered before the daemon says so', async () => {
    const h = await liveTarget()
    const r = await h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: TARGET }, body: 'stop and read this', urgency: 'interrupt' },
    )
    // An unwrapped operator line used to be "confirmed on injection", and the
    // sender was told `delivered` while nothing had been typed. The row is
    // handed on until the daemon's outcome lands.
    expect(r.disposition).toBe('queued')
    expect(await h.svc.message(r.message.id)).toMatchObject({
      deliveryStatus: 'dispatched',
      deliveredTo: TARGET,
    })
    expect(h.pushes.map((p) => p.fn)).toEqual(['interruptText'])
    expect(h.receiptsSeen.map((seen) => [seen.via, seen.receipt.outcome])).toEqual([
      ['interrupt', 'queued'],
    ])
    // A per-reader receipt says this session saw it; a row still waiting has
    // not been seen by anyone [POD-1379].
    expect((await h.store.messages.readReceipts(TARGET, [r.message.id])).has(r.message.id)).toBe(
      false,
    )
  })

  it('is confirmed once by the daemon’s outcome for its row, however often it repeats', async () => {
    const h = await liveTarget()
    const { id } = await interrupt(h, 'take it')

    await h.svc.onQueuedInputApplied(id, TARGET)
    await h.svc.onQueuedInputApplied(id, TARGET)

    expect(await h.svc.message(id)).toMatchObject({ deliveryStatus: 'confirmed', deliveredTo: TARGET })
    expect(await transitions(h, 'message.delivered', id)).toHaveLength(1)
    // The sweep never pushes a handed-on row again: the row IS the delivery.
    await h.svc.sweep()
    expect(h.pushes).toHaveLength(1)
  })

  it('records an unconfirmed row as unknown — never failed, never a resend (POD-4775)', async () => {
    const h = await liveTarget()
    const { id } = await interrupt(h, 'unproven, not failed')

    await h.svc.onQueuedInputUnknown(id, TARGET, 'delivery could not be confirmed')

    expect((await h.svc.message(id))!.deliveryStatus).toBe('unknown')
    expect(await notices(h)).toEqual([])
    await h.svc.sweep()
    expect(h.pushes).toHaveLength(1)

    // A later settlement still lands on it.
    await h.svc.onQueuedInputApplied(id, TARGET)
    expect((await h.svc.message(id))!.deliveryStatus).toBe('confirmed')
  })
})

describe('a send with files is a durable row like any other (POD-4795)', () => {
  it.each(['next-turn', 'interrupt'] as const)(
    'hands a %s send with files to the queue with its files',
    async (urgency) => {
      const h = await liveTarget()
      const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
        to: TARGET,
        body: 'here is the screenshot',
        attachments: [SHOT],
        urgency,
      })) as { id: string }

      expect((await h.svc.message(r.id))!.deliveryStatus).toBe('dispatched')
      expect(h.pushes).toEqual([
        expect.objectContaining({
          fn: urgency === 'interrupt' ? 'interruptText' : 'queueText',
          attachments: [SHOT],
        }),
      ])
      expect(h.receiptsSeen.map((seen) => seen.receipt.outcome)).toEqual(['queued'])
      expect(await notices(h)).toEqual([])
    },
  )

  it('ends an attachment send refused before anything was stamped [POD-2574]', async () => {
    // THE ONE SYNCHRONOUS REFUSAL THAT MUST NOT STAY QUEUED. A session with no
    // driver cannot take files at all, so leaving the row queued would hand the
    // sweep a row it can only refuse again, for the same reason, forever.
    // `unsupported` is a capability, not a moment.
    const h = await mailHarness({
      receipts: { answer: () => refused('unsupported', 'this agent cannot accept file attachments') },
    })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
      urgency: 'next-turn',
    })) as { id: string }

    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('failed')
    // No steward notice: the sender was already told, synchronously, by the
    // `ok: false` their own send returned. Two notices for one refusal is the
    // same disrespect as none, from the other side.
    expect(await notices(h)).toEqual([])
    // AND IT SAYS WHY [POD-2574]. A null reason falls through to "target gone"
    // — a claim about the SESSION, which is fine and still running. The stamp is
    // what separates "the driver refused" from "the target vanished".
    expect((await h.svc.message(r.id))!.deliveryDeferredReason).toBe('delivery-failed')
    expect((await h.svc.message(r.id))!.deliveryDeferredAt).toBeTruthy()
  })

  it('leaves a queue refusal that can clear for the sweep, and tells nobody', async () => {
    // The companion to the case above, and the reason it is scoped to
    // `unsupported`: a queue that cannot take the row right now (no process,
    // nothing to resume yet) is exactly what the sweep's retry is for.
    const h = await mailHarness({ receipts: { answer: () => refused('not_running') } })
    const iss = await h.createIssue({ title: 'target' })
    h.put({ sessionId: TARGET, issueId: iss.id, status: 'starting' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: TARGET,
      body: 'here is the screenshot',
      attachments: [SHOT],
      urgency: 'next-turn',
    })) as { id: string }

    // Stored on the server, not handed on: the sweep pushes it again.
    expect((await h.svc.message(r.id))!.deliveryStatus).toBe('stored')
    expect(await notices(h)).toEqual([])
  })
})
