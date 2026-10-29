import { asSessionId, type MessageRecordWire, type TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { messageAttachmentText } from './chat'

const id = '758cc885-68cc-44ec-83c3-531f071689a4'
const sessionId = asSessionId('9803e84b-270f-4974-9dd7-57910de16b85')
const path = `/home/podium/.podium/uploads/${sessionId}/${id}.png`
const attachment = { id, filename: 'image.png', mediaType: 'image/png', kind: 'image' as const }
const message = (body = 'Look at this image'): MessageRecordWire => ({
  id: 'message',
  sessionId,
  senderUserId: 'user',
  body,
  createdAt: '2026-10-29T20:14:53.927Z',
  status: 'confirmed',
  transcriptItem: { id: 'native-item' },
  attachments: [attachment],
})
const item = (text: string): TranscriptItem => ({ id: 'native-item', role: 'user', text })

describe('message attachment display text', () => {
  it('removes only the owned transport prefix and leaves receipt text untouched', () => {
    const raw = item(`${path}\nLook at this image`)
    expect(messageAttachmentText(raw, message())).toBe('Look at this image')
    expect(raw.text).toBe(`${path}\nLook at this image`)
  })

  it.each([
    path,
    '[Image #1]',
    '[Image #27] ',
  ])('shows an empty body for an image-only send: %s', (text) => {
    expect(messageAttachmentText(item(text), message(''))).toBe('')
  })

  it('handles several attachment paths and Windows staging', () => {
    const otherId = '175bac26-2b7e-41cd-a5c1-11e01437366d'
    const other = `C:\\Users\\person\\.podium\\uploads\\${sessionId}\\${otherId}.png`
    const record = { ...message(), attachments: [attachment, { ...attachment, id: otherId }] }
    expect(messageAttachmentText(item(`${path}\n${other}\n${record.body}`), record)).toBe(
      record.body,
    )
    expect(messageAttachmentText(item('[Image #1] [Image #2]'), { ...record, body: '' })).toBe('')
  })

  it.each([
    path,
    `> ${path}\n\nPlease explain this quoted path`,
    `Use this file:\n${path}`,
    `\n> ${path}\n\nPlease explain this quoted path`,
    `  Please preserve the indentation`,
    '[Image #1]',
  ])('preserves authored paths, quotes and placeholders: %s', (body) => {
    expect(messageAttachmentText(item(`${path}\n${body}`), message(body))).toBe(body)
    expect(messageAttachmentText(item(body), message(body))).toBe(body)
  })

  it('requires the same transcript identity, attachment id, session and saved body', () => {
    const raw = item(`${path}\nLook at this image`)
    for (const record of [
      undefined,
      { ...message(), transcriptItem: { id: 'another-item' } },
      { ...message(), attachments: [] },
      { ...message(), attachments: [{ ...attachment, id: undefined }] },
      { ...message(), attachments: [{ ...attachment, id: 'another-upload' }] },
      { ...message(), sessionId: asSessionId('another-session') },
      message('a different prompt'),
      message(raw.text),
    ])
      expect(messageAttachmentText(raw, record)).toBe(raw.text)
    expect(messageAttachmentText({ ...raw, role: 'assistant' }, message())).toBe(raw.text)
  })

  it('keeps embedded, quoted, repeated and unmatched path text', () => {
    for (const text of [
      `> ${path}\nLook at this image`,
      `\`${path}\`\nLook at this image`,
      `First\n${path}\nLook at this image`,
      `${path}\n${path}\nLook at this image`,
      `${path}\nLook at this image\nExtra text`,
      `${path.replace('/uploads/', '/pictures/')}\nLook at this image`,
    ])
      expect(messageAttachmentText(item(text), message())).toBe(text)
    expect(messageAttachmentText(item('[Image #1] [Image #2]'), message(''))).toBe(
      '[Image #1] [Image #2]',
    )
  })
})
