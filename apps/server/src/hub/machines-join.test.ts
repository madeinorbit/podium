import { decodeJoin } from '@podium/core/join'
import { describe, expect, it } from 'vitest'
import { buildJoinCommand } from './machines-join'

describe('buildJoinCommand', () => {
  it('embeds a wss serverUrl + pair code in a decodable token', () => {
    const line = buildJoinCommand({
      publicUrl: 'https://box.ts.net',
      pairCode: 'AB12',
      name: 'vps',
    })
    expect(line).toContain(
      'curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh -s -- --join ',
    )
    const marker = '--join '
    const token = line.slice(line.indexOf(marker) + marker.length).trim()
    expect(decodeJoin(token)).toEqual({
      v: 1,
      serverUrl: 'wss://box.ts.net',
      pairCode: 'AB12',
      name: 'vps',
    })
  })

  it('throws when no publicUrl is configured yet', () => {
    expect(() => buildJoinCommand({ publicUrl: undefined, pairCode: 'AB12' })).toThrow()
  })
})
