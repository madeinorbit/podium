import { describe, expect, it } from 'vitest'
import { assetUrl } from './asset-url'

describe('assetUrl', () => {
  const base = { httpOrigin: 'http://h:1', sessionId: 's1', fileDir: '/w/docs' }
  it('resolves a relative src against the file dir', () => {
    expect(assetUrl({ ...base, src: './img/a.png' })).toBe(
      'http://h:1/files/asset?sessionId=s1&path=%2Fw%2Fdocs%2Fimg%2Fa.png',
    )
  })
  it('resolves ../ segments', () => {
    expect(assetUrl({ ...base, src: '../x.png' })).toBe(
      'http://h:1/files/asset?sessionId=s1&path=%2Fw%2Fx.png',
    )
  })
  it('passes through remote/data srcs as null', () => {
    expect(assetUrl({ ...base, src: 'https://h/b.png' })).toBeNull()
    expect(assetUrl({ ...base, src: 'data:image/png;base64,AAAA' })).toBeNull()
  })
})
