import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uploadFilePath } from './upload'

describe('uploadFilePath', () => {
  it.each([
    ['image/png', 'abc.png'],
    ['image/jpeg', 'abc.jpg'],
    ['image/gif', 'abc.gif'],
    ['image/webp', 'abc.webp'],
    ['application/octet-stream', 'abc.bin'], // unknown MIME → .bin fallback
  ])('maps %s to %s under the session uploads dir', (mime, file) => {
    expect(uploadFilePath('/state', 'sess-1', 'abc', mime)).toBe(
      join('/state', 'uploads', 'sess-1', file),
    )
  })
})
