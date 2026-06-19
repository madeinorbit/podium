import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uploadFilePath } from './upload'

describe('uploadFilePath', () => {
  it('maps image/png to .png', () => {
    const p = uploadFilePath('/home/u', 'sess-1', 'abc', 'image/png')
    expect(p).toBe(join('/home/u', '.podium', 'uploads', 'sess-1', 'abc.png'))
  })

  it('maps image/jpeg to .jpg', () => {
    const p = uploadFilePath('/home/u', 'sess-1', 'abc', 'image/jpeg')
    expect(p).toBe(join('/home/u', '.podium', 'uploads', 'sess-1', 'abc.jpg'))
  })

  it('maps image/gif to .gif', () => {
    const p = uploadFilePath('/home/u', 'sess-1', 'abc', 'image/gif')
    expect(p).toBe(join('/home/u', '.podium', 'uploads', 'sess-1', 'abc.gif'))
  })

  it('maps image/webp to .webp', () => {
    const p = uploadFilePath('/home/u', 'sess-1', 'abc', 'image/webp')
    expect(p).toBe(join('/home/u', '.podium', 'uploads', 'sess-1', 'abc.webp'))
  })

  it('falls back to .bin for unknown MIME types', () => {
    const p = uploadFilePath('/home/u', 'sess-1', 'abc', 'application/octet-stream')
    expect(p).toBe(join('/home/u', '.podium', 'uploads', 'sess-1', 'abc.bin'))
  })

  it('is under ~/.podium/uploads/<sessionId>/', () => {
    const p = uploadFilePath('/home/u', 'my-session', 'id-xyz', 'image/png')
    expect(p.startsWith(join('/home/u', '.podium', 'uploads', 'my-session') + '/')).toBe(true)
  })

  it('constructs absolute path', () => {
    const p = uploadFilePath('/home/u', 's', 'i', 'image/png')
    expect(p.startsWith('/')).toBe(true)
  })
})
