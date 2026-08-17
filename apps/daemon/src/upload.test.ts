import { join } from 'node:path'
import { asSessionId } from '@podium/model'
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
    expect(uploadFilePath('/state', asSessionId('sess-1'), 'abc', mime)).toBe(
      join('/state', 'uploads', 'sess-1', file),
    )
  })

  /* POD-1203. Attachments stopped being screenshots, and the mime table only
   * ever knew four image formats — so every document the composer can now take
   * was landing as `abc.bin`, a file no harness opens. The name the operator's
   * own file had is the better source, and it is the one the mime table cannot
   * guess. */
  describe('with the original filename', () => {
    const path = (filename: string, mime = 'application/octet-stream') =>
      uploadFilePath('/state', asSessionId('sess-1'), 'abc', mime, filename)

    it.each([
      ['notes.pdf', 'abc.pdf'],
      ['data.CSV', 'abc.csv'],
      ['design.v2.sketch', 'abc.sketch'],
    ])('takes %s down to %s rather than the mime map', (filename, expected) => {
      expect(path(filename)).toBe(join('/state', 'uploads', 'sess-1', expected))
    })

    it('keeps the mime answer when the name carries no extension to take', () => {
      expect(path('screenshot', 'image/png')).toBe(join('/state', 'uploads', 'sess-1', 'abc.png'))
    })

    it('does not read a dotfile as one long extension', () => {
      expect(path('.gitignore')).toBe(join('/state', 'uploads', 'sess-1', 'abc.bin'))
    })

    /* Only the extension is taken, and only if it LOOKS like one. The filename
     * is untrusted input arriving over the wire; a name that tries to steer the
     * write somewhere else has to fall through to the mime map, not contribute
     * a path segment. */
    it.each([
      ['../../etc/passwd', 'abc.bin'],
      ['evil/..%2fx.', 'abc.bin'],
      ['long.extensionthatisnotone', 'abc.bin'],
    ])('refuses %s and falls back to the mime map', (filename, expected) => {
      expect(path(filename)).toBe(join('/state', 'uploads', 'sess-1', expected))
    })
  })
})
