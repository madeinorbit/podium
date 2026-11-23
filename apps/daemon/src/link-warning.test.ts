import { describe, expect, it } from 'vitest'
import { plainRemoteServerWarning } from './link-warning'

describe('plainRemoteServerWarning', () => {
  it.each([
    'ws://podium.example:18787',
    'http://192.168.1.10:18787',
    'ws://[fd00::1]:18787/',
  ])('warns for an unencrypted address on another computer: %s', (url) => {
    const warning = plainRemoteServerWarning(url)
    expect(warning).toContain(url)
    expect(warning).toContain('not encrypted')
    expect(warning).toContain('February 2027')
    expect(warning).toContain('wss://')
    expect(warning).toContain('trust')
  })

  it.each([
    'wss://podium.example',
    'https://podium.example',
    'ws://localhost:18787',
    'ws://127.0.0.1:18787',
    'http://127.4.5.6:18787',
    'ws://[::1]:18787',
    'not a url',
  ])('stays quiet for %s', (url) => {
    expect(plainRemoteServerWarning(url)).toBeUndefined()
  })
})
