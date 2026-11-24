import { TranscriptGraph } from '@podium/client-core/conversation'
import type { TranscriptItem } from '@podium/model'
import { runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobileConversationPresentation } from './conversation-presentation'
import { shapeMobileChatRow } from './transcript-feed'

it('addresses shared source metadata for split slots without demanding presentation content', () => {
  const source: TranscriptItem = {
    id: 'notes',
    role: 'user',
    ts: '2026-11-12T13:32:05Z',
    text: '[podium message msg_note · from issue:POD-1906 · to your session]\nReady to review\n[end podium message msg_note]\nOperator reply',
  }
  const graph = new TranscriptGraph([source])
  const shapeRow = vi.fn(shapeMobileChatRow)
  const phone = new MobileConversationPresentation(graph, shapeRow, (id) => graph.itemPosition(id))
  shapeRow.mockClear()
  try {
    expect(phone.keys.length).toBe(2)
    for (const key of phone.keys) expect(phone.sourceItem(key)).toBe(source)
    expect(phone.sourceItem('missing')).toBeUndefined()
    expect(shapeRow).not.toHaveBeenCalled()
    const updated = { ...source, ts: '2026-11-13T13:32:05Z' }
    runInAction(() => {
      graph.apply({ changed: [updated] })
      phone.apply(graph.rowPublication)
    })
    shapeRow.mockClear()
    for (const key of phone.keys) expect(phone.sourceItem(key)).toBe(updated)
    expect(shapeRow).not.toHaveBeenCalled()
  } finally {
    phone.dispose()
    graph.dispose()
  }
})
