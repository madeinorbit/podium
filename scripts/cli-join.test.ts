import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from '../packages/core/src/config'
import { encodeJoin } from '../packages/core/src/join'
import { applyJoinToken } from './cli-join'

describe('applyJoinToken', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-join-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a daemon config from a valid token', () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1', name: 'vps' })
    expect(applyJoinToken(token)).toEqual({ name: 'vps' })
    expect(loadConfig()).toEqual({
      mode: 'daemon',
      serverUrl: 'wss://h',
      pairCode: 'P1',
      pendingPersistence: 'systemd',
    })
  })
  it('preserves the update channel across a join (#20 — install.sh --channel edge --join)', () => {
    saveConfig({ updateChannel: 'edge' })
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1' })
    applyJoinToken(token)
    expect(loadConfig().updateChannel).toBe('edge')
    expect(loadConfig().mode).toBe('daemon')
  })
  it('falls back to "this machine" when the token has no name', () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1' })
    expect(applyJoinToken(token).name).toBe('this machine')
  })
  it('throws on a malformed token', () => {
    expect(() => applyJoinToken('garbage!')).toThrow()
  })
})
