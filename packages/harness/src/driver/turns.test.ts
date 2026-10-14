import { describe, expect, it } from 'vitest'
import {
  type AttachmentRef,
  attachmentKindFor,
  splitAttachments,
  textWithAttachmentPaths,
} from './turns.js'

const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
  id: 'a1',
  path: '/staged/a1.png',
  filename: 'a1.png',
  mediaType: 'image/png',
  kind: 'image',
  ...over,
})

describe('attachment forms (POD-6093)', () => {
  it('calls only a format every provider shows as pixels an image', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'Image/PNG; x=1'])
      expect(attachmentKindFor(type)).toBe('image')
    for (const type of ['image/svg+xml', 'image/heic', 'application/zip', 'text/csv', ''])
      expect(attachmentKindFor(type)).toBe('file')
  })

  it('splits by the media type, not the kind alone', () => {
    const png = ref({})
    const svg = ref({ id: 'a2', path: '/staged/a2.svg', mediaType: 'image/svg+xml' })
    const zip = ref({
      id: 'a3',
      path: '/staged/a3.zip',
      mediaType: 'application/zip',
      kind: 'file',
    })
    expect(splitAttachments([png, svg, zip])).toEqual({ images: [png], files: [svg, zip] })
    expect(splitAttachments(undefined)).toEqual({ images: [], files: [] })
  })

  it('puts each path on its own line ahead of the text', () => {
    const zip = ref({ path: '/staged/a3.zip' })
    const csv = ref({ path: '/staged/a4.csv' })
    expect(textWithAttachmentPaths('read these', [zip, csv])).toBe(
      '/staged/a3.zip\n/staged/a4.csv\nread these',
    )
    expect(textWithAttachmentPaths('', [zip])).toBe('/staged/a3.zip')
    expect(textWithAttachmentPaths('plain', [])).toBe('plain')
  })
})
