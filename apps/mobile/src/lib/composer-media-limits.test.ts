import { describe, expect, it, vi } from 'vitest'
import {
  checkedClipboardImage,
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PICK,
  readAttachmentsSequentially,
  type AttachmentReadSource,
} from './composer-media-limits'

const source = (name: string, size?: number): AttachmentReadSource => ({
  name,
  mimeType: 'application/pdf',
  previewUri: '',
  uri: `file:///${name}`,
  ...(size === undefined ? {} : { size }),
})

describe('native attachment memory limits', () => {
  it('accepts the exact decoded boundary and rejects one byte over before reading', async () => {
    const base64Of = vi.fn(async () => 'safe')
    const result = await readAttachmentsSequentially(
      [source('edge.pdf', MAX_ATTACHMENT_BYTES), source('large.pdf', MAX_ATTACHMENT_BYTES + 1)],
      { sizeOf: vi.fn(), base64Of },
    )
    expect(result[0]).toMatchObject({ name: 'edge.pdf', dataBase64: 'safe' })
    expect(result[1]).toMatchObject({ name: 'large.pdf', error: expect.stringContaining('7.5 MB') })
    expect(base64Of).toHaveBeenCalledTimes(1)
  })

  it('validates encoded length when provider size is unknown', async () => {
    const result = await readAttachmentsSequentially([source('unknown.bin')], {
      sizeOf: vi.fn(async () => undefined),
      base64Of: vi.fn(async () => 'x'.repeat(MAX_ATTACHMENT_BASE64_CHARS + 1)),
    })
    expect(result[0]).toMatchObject({ error: expect.stringContaining('7.5 MB') })
  })

  it('reads in series, preserves accepted files, and reports the bounded remainder', async () => {
    let concurrent = 0
    let peak = 0
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_PICK + 2 }, (_, index) =>
      source(`${index}.txt`, 1),
    )
    const result = await readAttachmentsSequentially(files, {
      sizeOf: vi.fn(),
      base64Of: vi.fn(async (item) => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await Promise.resolve()
        concurrent -= 1
        return item.name
      }),
    })
    expect(peak).toBe(1)
    expect(
      result.slice(0, MAX_ATTACHMENTS_PER_PICK).every((file) => file.error === undefined),
    ).toBe(true)
    expect(result.at(-1)).toMatchObject({ error: 'Attach up to 4 files at a time.' })
  })

  it('turns an oversized clipboard payload into a visible file failure', () => {
    expect(checkedClipboardImage('x'.repeat(MAX_ATTACHMENT_BASE64_CHARS + 1))).toMatchObject({
      error: expect.stringContaining('7.5 MB'),
    })
  })
})
