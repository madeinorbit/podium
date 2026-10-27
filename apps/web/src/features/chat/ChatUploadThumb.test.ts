import { describe, expect, it } from 'vitest'
import { stagedAttachmentId } from './ChatUploadThumb'

describe('stagedAttachmentId (POD-2148)', () => {
  const id = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b'

  it('reads the id off a daemon-staged upload path', () => {
    expect(stagedAttachmentId(`/home/u/.podium/uploads/s-1/${id}.png`)).toBe(id)
    expect(stagedAttachmentId(`C:\\Users\\u\\.podium\\uploads\\s-1\\${id}.jpeg`)).toBe(id)
  })

  it('names no id for a path outside an upload dir or not named by one', () => {
    expect(stagedAttachmentId(`/repo/shots/${id}.png`)).toBeUndefined()
    expect(stagedAttachmentId('/home/u/.podium/uploads/s-1/shot.png')).toBeUndefined()
    expect(stagedAttachmentId(`${id}.png`)).toBeUndefined()
  })
})
