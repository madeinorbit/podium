import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coordinatorHttpUrl, readPairedMachineId, runPayloadRepair } from './payload-repair'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('payload repair CLI', () => {
  it('maps the paired WebSocket authority to its HTTP tRPC origin', () => {
    expect(coordinatorHttpUrl('wss://hub.example/podium')).toBe('https://hub.example/podium')
    expect(coordinatorHttpUrl('ws://127.0.0.1:18787')).toBe('http://127.0.0.1:18787')
  })

  it('reads the durable paired machine identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-payload-repair-'))
    roots.push(root)
    writeFileSync(join(root, 'daemon.json'), JSON.stringify({ machineId: 'machine-macbook' }))
    expect(readPairedMachineId(root)).toBe('machine-macbook')
  })

  it('asks the coordinator to re-grant equal-version bytes to a paired daemon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-payload-repair-'))
    roots.push(root)
    writeFileSync(join(root, 'daemon.json'), JSON.stringify({ machineId: 'machine-macbook' }))
    const mutate = vi.fn(async () => ({
      outcome: { result: 'granted', version: '0.4.2' },
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runPayloadRepair({
      serverUrl: 'wss://hub.example',
      pairedDaemon: true,
      stateDir: root,
      client: { updates: { repairPayload: { mutate } } },
    })

    expect(mutate).toHaveBeenCalledWith({ id: 'machine-macbook' })
  })

  it('lets an all-in-one coordinator default repair to its host machine', async () => {
    const mutate = vi.fn(async () => ({
      outcome: { result: 'granted', version: '0.4.2' },
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runPayloadRepair({
      serverUrl: 'http://127.0.0.1:18787',
      pairedDaemon: false,
      client: { updates: { repairPayload: { mutate } } },
    })

    expect(mutate).toHaveBeenCalledWith(undefined)
  })
})
