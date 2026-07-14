import { describe, expect, it } from 'vitest'
import { assetUrl, scopedAssetUrl } from './asset-url'

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

describe('scopedAssetUrl (artifact scope) [spec:SP-0fc9]', () => {
  const scope = { kind: 'artifact', issueId: 'iss_1', artifactId: 'abc123' } as const
  const base = { httpOrigin: 'http://h:1/', scope, fileDir: '' }

  it('serves relative srcs from the permanent artifact store', () => {
    expect(scopedAssetUrl({ ...base, src: 'pic.png' })).toBe(
      'http://h:1/files/artifact/iss_1/abc123/pic.png',
    )
    expect(scopedAssetUrl({ ...base, src: './img/a b.png' })).toBe(
      'http://h:1/files/artifact/iss_1/abc123/img/a%20b.png',
    )
  })

  it('resolves against the html file dir inside the bundle', () => {
    expect(scopedAssetUrl({ ...base, fileDir: 'sub', src: '../pic.png' })).toBe(
      'http://h:1/files/artifact/iss_1/abc123/pic.png',
    )
    // A leading / means the artifact root, not the host filesystem.
    expect(scopedAssetUrl({ ...base, fileDir: 'sub', src: '/pic.png' })).toBe(
      'http://h:1/files/artifact/iss_1/abc123/pic.png',
    )
  })

  it('refuses srcs that escape the artifact dir', () => {
    expect(scopedAssetUrl({ ...base, src: '../pic.png' })).toBeNull()
    expect(scopedAssetUrl({ ...base, fileDir: 'sub', src: '../../etc/passwd' })).toBeNull()
  })

  it('leaves remote/data/blob srcs untouched (null)', () => {
    expect(scopedAssetUrl({ ...base, src: 'https://h/b.png' })).toBeNull()
    expect(scopedAssetUrl({ ...base, src: 'data:image/png;base64,AAAA' })).toBeNull()
    expect(scopedAssetUrl({ ...base, src: 'blob:http://h/xyz' })).toBeNull()
  })
})
