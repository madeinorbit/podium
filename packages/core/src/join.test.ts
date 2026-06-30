import { describe, expect, it } from 'vitest'
import { decodeJoin, encodeJoin, type JoinPayload } from './join'

const sample: JoinPayload = {
  v: 1,
  serverUrl: 'wss://box.tail1234.ts.net',
  pairCode: 'AB12-CD34',
  name: 'vps-box',
}

describe('join token codec', () => {
  it('round-trips a payload', () => {
    expect(decodeJoin(encodeJoin(sample))).toEqual(sample)
  })
  it('produces a URL-safe token with no padding', () => {
    const t = encodeJoin(sample)
    expect(t).not.toMatch(/[+/=]/)
  })
  it('round-trips without the optional name', () => {
    const p: JoinPayload = { v: 1, serverUrl: 'ws://h:18787', pairCode: 'X1' }
    expect(decodeJoin(encodeJoin(p))).toEqual(p)
  })
  it('rejects a non-base64url / garbage token', () => {
    expect(() => decodeJoin('!!!not a token!!!')).toThrow()
  })
  it('rejects a token whose JSON fails schema (wrong version)', () => {
    const bad = Buffer.from(JSON.stringify({ v: 2, serverUrl: 'x', pairCode: 'y' })).toString(
      'base64url',
    )
    expect(() => decodeJoin(bad)).toThrow()
  })
  it('rejects a token missing required fields', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, serverUrl: 'x' })).toString('base64url')
    expect(() => decodeJoin(bad)).toThrow()
  })
})
