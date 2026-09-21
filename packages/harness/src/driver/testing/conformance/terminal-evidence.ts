/** Adversarial worlds for the terminal receipt contract. The driver and its
 * clock run normally; these controls change only what the provider reports.
 * Kept alongside the shared corpus so no harness gets its own acceptance rule. */
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { drainUntil } from './suite.js'
import type { ConformanceTarget } from './target.js'

export interface TerminalEvidenceControl {
  /** Stop automatic transcript echoes; submitted text remains observable. */
  hold(sessionId: SessionId): void
  /** Resolve at the submitting CR, before the next virtual verification tick.
   * Fail with a bounded timeout if the driver never submits these turns. */
  submitted(sessionId: SessionId, count: number): Promise<readonly string[]>
  /** A user item independent of any send, including foreign or altered text. */
  userTurn(sessionId: SessionId, text: string): void
  /** The raw provider hook; only profiles declaring hook proof consume it. */
  hook(sessionId: SessionId, text: string): void
  /** Feed both producer arms for ONE provider boundary, in either order. */
  boundary(sessionId: SessionId, phase: 'working' | 'idle', order: 'state-first' | 'observation-first'): void
}

export interface TerminalEvidenceTarget extends ConformanceTarget {
  createDriver(): ReturnType<ConformanceTarget['createDriver']> & { evidence: TerminalEvidenceControl }
}

export function describeTerminalEvidenceConformance(target: TerminalEvidenceTarget): void {
  describe(`terminal evidence conformance — ${target.name}`, () => {
    afterEach(() => target.reset())
    const setup = async () => {
      target.reset()
      const world = target.createDriver()
      const session = await world.driver.create(target.spec())
      world.evidence.hold(session.binding.sessionId)
      return { ...world, session, id: session.binding.sessionId }
    }
    const sendOptions = { origin: 'human', delivery: 'when-ready' } as const

    it('a foreign user turn cannot credit a waiting send', async () => {
      const { session, evidence, control, id } = await setup()
      const pending = session.send({ text: 'send-owned amber request' }, sendOptions)
      expect(await evidence.submitted(id, 1)).toEqual(['send-owned amber request'])
      evidence.userTurn(id, 'a person typed an unrelated violet request')
      expect(await pending).toMatchObject({ outcome: 'unverified' })
      expect(control.textDeliveries(id)).toBe(1)
    })

    it('one transcript echo credits only its matching overlapping send', async () => {
      const { session, evidence, control, id } = await setup()
      const first = session.send({ text: 'first amber request' }, sendOptions)
      await evidence.submitted(id, 1)
      const second = session.send({ text: 'second violet request' }, sendOptions)
      expect(await evidence.submitted(id, 2)).toEqual(['first amber request', 'second violet request'])
      evidence.userTurn(id, 'second violet request')
      const receipts = await Promise.all([first, second])
      expect(receipts[0]).toMatchObject({ outcome: 'unverified' })
      expect(receipts[1]).toMatchObject({ outcome: 'accepted', provenBy: 'transcript-echo' })
      expect(control.textDeliveries(id)).toBe(2)
    })

    it('reflowed whitespace still proves the complete submitted text', async () => {
      const { session, evidence, id } = await setup()
      const pending = session.send({ text: 'preserve these words\nand their order' }, sendOptions)
      await evidence.submitted(id, 1)
      evidence.userTurn(id, '  preserve\r\nthese\twords and\n their order  ')
      expect(await pending).toMatchObject({ outcome: 'accepted', provenBy: 'transcript-echo' })
    })

    it.each([
      ['truncated', 'preserve these words…'],
      ['decorated with unrelated content', 'OTHER REQUEST: preserve these words and their order'],
    ])('an echo %s cannot prove the complete submitted text', async (_shape, echo) => {
      const { session, evidence, id } = await setup()
      const pending = session.send({ text: 'preserve these words and their order' }, sendOptions)
      await evidence.submitted(id, 1)
      evidence.userTurn(id, echo)
      expect(await pending).toMatchObject({ outcome: 'unverified' })
    })

    it('a hook credits only its matching overlapping send when hook proof is declared', async () => {
      const { session, evidence, driver, id } = await setup()
      const first = session.send({ text: 'first amber request' }, sendOptions)
      await evidence.submitted(id, 1)
      const second = session.send({ text: 'second violet request' }, sendOptions)
      expect(await evidence.submitted(id, 2)).toEqual(['first amber request', 'second violet request'])
      evidence.hook(id, 'second violet request')
      const receipts = await Promise.all([first, second])
      expect(receipts[0]).toMatchObject({ outcome: 'unverified' })
      expect(receipts[1]).toMatchObject(driver.capabilities().send.proof.includes('hook')
        ? { outcome: 'accepted', provenBy: 'hook' }
        : { outcome: 'unverified' })
    })

    it.each(['state-first', 'observation-first'] as const)(
      'two lifecycle producers report each boundary once (%s)', async (order) => {
        const { session, evidence, id } = await setup()
        const before = await session.snapshot()
        for (let turn = 0; turn < 2; turn++) {
          evidence.boundary(id, 'working', order)
          evidence.boundary(id, 'idle', order)
        }
        const after = await session.snapshot()
        // Read through the final snapshot cursor, including any duplicate
        // before it. A driver emitting nothing fails within the shared bound.
        const events = await drainUntil(session.events(before.cursor), (event) =>
          JSON.stringify(event.cursor) === JSON.stringify(after.cursor))
        expect(events.filter((event) => event.t === 'turn').map((event) => event.ev.ev))
          .toEqual(['started', 'completed', 'started', 'completed'])
        expect(after.turnEpoch).toBe(2)
      },
    )
  })
}
