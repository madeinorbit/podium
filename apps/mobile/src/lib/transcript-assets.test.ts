import { describe, expect, it } from 'vitest'
import { pathBasename, sessionAssetUrl } from './transcript-assets'

describe('sessionAssetUrl', () => {
  const context = {
    httpOrigin: 'https://podium.test/',
    sessionId: 'ses 1',
    cwd: '/work/repo/',
  }

  it('resolves relative paths against the session cwd and URL-encodes them', () => {
    expect(sessionAssetUrl(context, 'shots/final image.png')).toBe(
      'https://podium.test/files/asset?sessionId=ses+1&path=%2Fwork%2Frepo%2Fshots%2Ffinal+image.png',
    )
  })

  it('keeps absolute paths absolute', () => {
    expect(sessionAssetUrl(context, '/tmp/report.md')).toContain('path=%2Ftmp%2Freport.md')
  })
})

describe('pathBasename', () => {
  it('returns the final non-empty segment', () => {
    expect(pathBasename('/work/shots/final.png')).toBe('final.png')
  })
})
