import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeUpstreamUrl, readOwnDaemonMachineId } from './upstream'

describe('normalizeUpstreamUrl', () => {
  it('derives http+ws bases from any scheme, trailing slash tolerated', () => {
    expect(normalizeUpstreamUrl('http://hub:18787/')).toEqual({
      http: 'http://hub:18787',
      ws: 'ws://hub:18787',
    })
    expect(normalizeUpstreamUrl('https://hub.example')).toEqual({
      http: 'https://hub.example',
      ws: 'wss://hub.example',
    })
    expect(normalizeUpstreamUrl('ws://hub:18787')).toEqual({
      http: 'http://hub:18787',
      ws: 'ws://hub:18787',
    })
    expect(normalizeUpstreamUrl('wss://hub.example/')).toEqual({
      http: 'https://hub.example',
      ws: 'wss://hub.example',
    })
  })
})

describe('readOwnDaemonMachineId', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'podium-upstream-id-'))
    dirs.push(d)
    return d
  }

  it('reads the daemon identity machineId (the hub-side echo-filter key)', () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'm-abc', token: 't' }))
    expect(readOwnDaemonMachineId(dir)).toBe('m-abc')
  })

  it('absent or corrupt identity file → undefined (nothing to filter)', () => {
    expect(readOwnDaemonMachineId(tmp())).toBeUndefined()
    const dir = tmp()
    writeFileSync(join(dir, 'daemon.json'), 'not json')
    expect(readOwnDaemonMachineId(dir)).toBeUndefined()
    const dir2 = tmp()
    writeFileSync(join(dir2, 'daemon.json'), JSON.stringify({ machineId: 42 }))
    expect(readOwnDaemonMachineId(dir2)).toBeUndefined()
  })
})
