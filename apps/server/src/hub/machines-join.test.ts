import { spawnSync } from 'node:child_process'
import { decodeJoin } from '@podium/runtime/join'
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
      'https://github.com/madeinorbit/podium/releases/latest/download/install.sh --channel stable --agents codex,claude-code,grok --join ',
    )
    expect(line).toContain('apt-get install -y --no-install-recommends ca-certificates curl')
    expect(line).toContain('apk add --no-cache ca-certificates curl')
    expect(line).toContain('podium-install.$$')
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

  it('uses and persists the edge release train when the server runs edge', () => {
    const line = buildJoinCommand({
      publicUrl: 'https://box.ts.net',
      pairCode: 'AB12',
      channel: 'edge',
    })
    expect(line).toContain(
      'https://github.com/madeinorbit/podium/releases/download/edge/install.sh --channel edge --agents codex,claude-code,grok --join ',
    )
  })

  it('produces valid POSIX shell syntax', () => {
    const line = buildJoinCommand({
      publicUrl: 'https://box.ts.net',
      pairCode: 'AB12',
      channel: 'edge',
    })

    const parsed = spawnSync('sh', ['-n', '-c', line], { encoding: 'utf8' })
    expect(parsed.stderr).toBe('')
    expect(parsed.status).toBe(0)
  })
})
