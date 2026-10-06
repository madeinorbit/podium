import { asSessionId, type MessageRecordWire, type TranscriptItem } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { insideArm, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { createSendsFixture } from './model-test-support'
import { projectConversation } from './projection'

// Count calls to the actual pure projection without replacing its behavior.
vi.mock('./projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projection')>()
  return { ...actual, projectConversation: vi.fn(actual.projectConversation) }
})

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    port: {
      getSnapshot: vi.fn(() => value),
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

it('keeps context, offer and retract work independent of transcript size and suspends it while stopped', async () => {
  async function measured(scale: 1 | 4) {
    let idReads = 0
    const items = Array.from(
      { length: 128 * scale },
      (_, index): TranscriptItem => ({
        get id() {
          idReads += 1
          return `history-${index}`
        },
        role: 'assistant',
        text: 'retained history',
      }),
    )
    const feed = source({ items })
    const record: MessageRecordWire = {
      id: 'held',
      sessionId: asSessionId('chat'),
      senderUserId: 'operator',
      body: 'current prompt',
      createdAt: '2026-09-29T10:00:00.000Z',
      status: 'stored',
    }
    const records = source<readonly MessageRecordWire[]>([record])
    const controller = createSendsFixture({
      sessionId: asSessionId('chat'),
      transcript: feed.port,
      records: records.port,
      createDeliveryId: () => 'new',
      deliver: async () => ({ state: 'sent' }),
      retract: async () => 'typed',
      dismissOffer: async () => {},
    })
    const measure = async (action: () => unknown) => {
      idReads = 0
      feed.port.getSnapshot.mockClear()
      records.port.getSnapshot.mockClear()
      vi.mocked(projectConversation).mockClear()
      const report = await measureWork(async () => {
        await insideArm(action)
      })
      return {
        work: report.work,
        idReads,
        transcriptReads: feed.port.getSnapshot.mock.calls.length,
        recordReads: records.port.getSnapshot.mock.calls.length,
        projections: vi.mocked(projectConversation).mock.calls.length,
      }
    }
    const context = {
      canInterrupt: true,
      offer: {
        message: 'Choose',
        createdAt: '2026-09-29T10:01:00.000Z',
        actions: [{ label: 'Next', prompt: 'next' }],
      },
    }
    try {
      const beforeStart = await measure(() => controller.updateContext(context))
      expect(beforeStart).toMatchObject({
        idReads: 0,
        transcriptReads: 0,
        recordReads: 0,
        projections: 0,
      })
      controller.start()
      expect(controller.getSnapshot().bubbles).toHaveLength(1)

      const updateContext = await measure(() => controller.updateContext(context))
      const offer = await measure(() => controller.dismissOffer(context.offer.createdAt))
      const retract = await measure(() => controller.retract('held'))
      const recordUpdate = await measure(() => records.set([{ ...record, status: 'accepted' }]))
      const draft = await measure(() => {
        for (let index = 0; index < 60; index++) controller.setDraft(`key ${index}`)
      })
      for (const action of [updateContext, offer, retract, recordUpdate]) {
        expect(action.idReads).toBe(0)
        expect(action.transcriptReads).toBe(0)
        expect(action.projections).toBeLessThanOrEqual(1)
      }
      expect(draft).toMatchObject({
        idReads: 0,
        transcriptReads: 0,
        recordReads: 0,
        projections: 0,
      })

      // The actual former projection enumerated every retained item on each
      // patch. This control proves that both counters would detect its return.
      const control = await measure(() =>
        projectConversation({
          turns: [],
          records: [record],
          transcriptIds: new Set(items.map((item) => item.id)),
          seenOpen: new Set(['held']),
          hidden: new Set(),
        }),
      )
      expect(control.idReads).toBe(128 * scale)

      controller.stop()
      const stopped = await measure(() => {
        feed.set({ items: [{ id: 'native', role: 'user', text: 'confirmed prompt' }] })
        records.set([
          { ...record, status: 'confirmed', transcriptItem: { id: 'native', cursor: 'c1' } },
        ])
        controller.updateContext({ canInterrupt: false })
      })
      expect(stopped).toMatchObject({
        idReads: 0,
        transcriptReads: 0,
        recordReads: 0,
        projections: 0,
      })
      controller.start()
      expect(controller.getSnapshot().bubbles).toEqual([])
      expect(controller.getSnapshot().offer).toBeNull()
      expect(controller.getSnapshot().canInterrupt).toBe(false)
      const reopened = await measure(() => controller.updateContext({ canInterrupt: true }))
      expect(reopened).toMatchObject({ idReads: 0, transcriptReads: 0, projections: 0 })
      return {
        scale,
        actions: {
          beforeStart,
          updateContext,
          offer,
          retract,
          recordUpdate,
          draft,
          stopped,
          reopened,
        },
        control,
      }
    } finally {
      controller.dispose()
    }
  }
  const one = await measured(1)
  const four = await measured(4)
  expect(four.actions).toEqual(one.actions)
  expect(four.control.idReads).toBe(one.control.idReads * 4)
  expect(four.control.work.elements).toBeGreaterThan(one.control.work.elements * 3)
  console.log('[conversation patch work1x4x]', JSON.stringify([one, four]))
})
