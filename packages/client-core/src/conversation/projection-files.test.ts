import { asSessionId, type MessageRecordWire } from '@podium/model'
import { expect, it } from 'vitest'
import { projectConversation } from './projection'

it('carries each record attachment’s staged id onto the bubble’s files (POD-2148)', () => {
  const record: MessageRecordWire = {
    id: 'msg-1',
    sessionId: asSessionId('s-1'),
    senderUserId: 'u-1',
    body: 'look',
    attachments: [
      { id: 'att-1', filename: 'shot.png', mediaType: 'image/png', kind: 'image' },
      { filename: 'old.png', mediaType: 'image/png', kind: 'image' },
    ],
    createdAt: '2026-10-01T12:00:00Z',
    status: 'stored',
  }
  const [bubble] = projectConversation({
    turns: [],
    records: [record],
    transcriptIds: new Set(),
    seenOpen: new Set(),
    hidden: new Set(),
  })
  expect(bubble?.files).toEqual([
    { path: 'shot.png', kind: 'image', attachmentId: 'att-1' },
    { path: 'old.png', kind: 'image' },
  ])
})
