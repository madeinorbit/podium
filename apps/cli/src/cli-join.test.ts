import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_CONFIG_VERSION, loadConfig, saveConfig } from '@podium/runtime/config'
import { encodeJoin } from '@podium/runtime/join'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyJoinToken } from './cli-join'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('applyJoinToken', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-join-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** The join now asks the server where its UI is (PDM-34). Every case below is a
   *  server that does not answer, which is the self-hosted shape and must be
   *  indistinguishable from the behaviour before that call existed. */
  const serverIsUnreachable = () =>
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

  it('writes a daemon config from a valid token', async () => {
    serverIsUnreachable()
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1', name: 'vps' })
    await expect(applyJoinToken(token)).resolves.toEqual({ name: 'vps' })
    expect(loadConfig()).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      mode: 'daemon',
      serverUrl: 'wss://h',
      pairCode: 'P1',
      persistence: 'systemd',
    })
  })
  it('preserves the update channel across a join (#20 — install.sh --channel edge --join)', async () => {
    serverIsUnreachable()
    saveConfig({ updateChannel: 'edge' })
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1' })
    await applyJoinToken(token)
    expect(loadConfig().updateChannel).toBe('edge')
    expect(loadConfig().mode).toBe('daemon')
  })
  it('falls back to "this machine" when the token has no name', async () => {
    serverIsUnreachable()
    const token = encodeJoin({ v: 1, serverUrl: 'wss://h', pairCode: 'P1' })
    expect((await applyJoinToken(token)).name).toBe('this machine')
  })
  it('rejects a malformed token', async () => {
    await expect(applyJoinToken('garbage!')).rejects.toThrow()
  })

  /** PDM-34: a machine joined from the terminal must land in the same state as one
   *  joined from the setup screen — including knowing where the UI lives. */
  it('records the UI origin the joined server advertises', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ appUrl: 'https://app.meetpodium.com' }),
    } as Response)
    const token = encodeJoin({ v: 1, serverUrl: 'wss://api.meetpodium.com', pairCode: 'P1' })
    await applyJoinToken(token)
    expect(loadConfig().uiUrl).toBe('https://app.meetpodium.com')
  })
})
