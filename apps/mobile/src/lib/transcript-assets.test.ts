import { asSessionId, machinePathBasename } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { sessionAssetUrl } from './transcript-assets'

describe('sessionAssetUrl', () => {
  const context = {
    httpOrigin: 'https://podium.test/',
    sessionId: asSessionId('ses 1'),
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

describe('machinePathBasename', () => {
  it('returns the final non-empty segment', () => {
    expect(machinePathBasename('/work/shots/final.png')).toBe('final.png')
  })
})

it('serves Windows transcript assets using the machine cwd', () => {
  const context = {
    httpOrigin: 'https://podium.test',
    sessionId: asSessionId('s1'),
    cwd: 'C:\\repo',
  }
  const path = (value: string) => new URL(sessionAssetUrl(context, value)).searchParams.get('path')
  expect(path('shots\\..\\final image.png')).toBe('C:\\repo\\final image.png')
  expect(path('D:/shots/final.png')).toBe('D:\\shots\\final.png')
  expect(path('\\\\nas\\share\\final.png')).toBe('\\\\nas\\share\\final.png')
  expect(machinePathBasename('C:\\shots\\final.png')).toBe('final.png')
})
