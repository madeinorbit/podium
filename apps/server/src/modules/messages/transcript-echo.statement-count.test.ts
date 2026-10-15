/**
 * A transcript delta reads every echoed message in one statement, whatever the
 * number of echoes in the frame [POD-6149, server-data rule 8]. It used to read
 * them one per item.
 */
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { expectConstantStatements } from '../../test-support/statement-count'
import { type MailHarness, mailHarness } from './characterization-support'

const echo = (id: string) => ({ role: 'user', text: `[podium message ${id} · from x]\nx\n[end podium message ${id}]` })

describe('transcript delta echo confirmation: pinned statement count at 5 and 200 echoes', () => {
  it('reads all echoed rows together', async () => {
    await expectConstantStatements<{ h: MailHarness; ids: string[] }>(
      {
        name: 'onTranscriptDelta',
        setup: async (size) => {
          const h = await mailHarness()
          const iss = await h.createIssue({ title: 'target' })
          h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
          h.put({ sessionId: asSessionId('sOther'), issueId: iss.id, phase: 'idle' })
          const ids: string[] = []
          for (let i = 0; i < size; i++) {
            const sent = await h.svc.send(
              { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sFrom') },
              { to: { kind: 'session', id: 's1' }, body: `m${i}`, urgency: 'next-turn' },
            )
            ids.push(sent.message.id)
          }
          return { h, ids }
        },
        target: ({ h }) => h.store,
        // Another session quoting every id: each row is read and none confirmed,
        // so the count is the reads alone.
        run: async ({ h, ids }) =>
          await h.svc.onTranscriptDelta(asSessionId('sOther'), [...ids.map(echo), { role: 'user', text: 'no echo' }]),
        check: async (_result, { h, ids }) => {
          for (const id of [ids[0]!, ids.at(-1)!]) {
            expect((await h.svc.message(id))!.deliveryStatus).not.toBe('confirmed')
          }
        },
        teardown: async ({ h }) => await h.store.close(),
      },
      1,
    )
  })

  it('still confirms each echo of a push to this session once', async () => {
    const h = await mailHarness()
    try {
      const iss = await h.createIssue({ title: 'target' })
      h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
      const sent = await h.svc.send(
        { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sFrom') },
        { to: { kind: 'session', id: 's1' }, body: 'x', urgency: 'next-turn' },
      )
      const id = sent.message.id
      expect((await h.svc.message(id))!.deliveryStatus).toBe('dispatched')
      // The same echo twice in one frame, plus an id nobody sent.
      await h.svc.onTranscriptDelta(asSessionId('s1'), [echo(id), echo('msg_unknown'), echo(id)])
      expect((await h.svc.message(id))!.deliveryStatus).toBe('confirmed')
      expect((await h.events(['message.delivered'])).map((e) => (e.payload as { confirmedVia: string }).confirmedVia)).toEqual(['echo'])
    } finally {
      await h.store.close()
    }
  })
})
