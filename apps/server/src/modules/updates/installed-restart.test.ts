import type { SpawnOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createInstalledCoordinatorRestart,
  createInstalledCoordinatorUpdate,
} from './installed-restart'

const immediate = (callback: () => void) => {
  callback()
  return { unref: vi.fn() }
}

describe('createInstalledCoordinatorRestart', () => {
  it('is absent without a real restart authority', () => {
    expect(
      createInstalledCoordinatorRestart({ instanceId: 'default', port: () => 18787, env: {} }),
    ).toBeUndefined()
  })

  it('hands a detached coordinator to new janitor, server, and daemon processes', () => {
    const children: Array<{ unref: ReturnType<typeof vi.fn> }> = []
    const spawnProcess = vi.fn(() => {
      const child = { unref: vi.fn() }
      children.push(child)
      return child
    })
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'default',
      port: () => 19001,
      env: { PODIUM_RUN_MODE: 'detached' },
      execPath: '/opt/podium/podium',
      spawnProcess,
      schedule: immediate,
    })

    restart?.()

    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      '/opt/podium/podium',
      ['janitor', '--server', 'http://127.0.0.1:19001', '--takeover'],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ PODIUM_RUN_MODE: 'detached', PODIUM_PORT: '19001' }),
      }),
    )
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      '/opt/podium/podium',
      ['daemon', '--local', '--takeover'],
      expect.objectContaining({ detached: true }),
    )
    expect(spawnProcess).toHaveBeenNthCalledWith(
      3,
      '/opt/podium/podium',
      ['server', '--takeover'],
      expect.objectContaining({ detached: true }),
    )
    expect(children.every((child) => child.unref.mock.calls.length === 1)).toBe(true)
  })

  it('preserves a detached server-only topology without creating a daemon', () => {
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => ({
        unref: vi.fn(),
      }),
    )
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'default',
      port: () => 19001,
      env: { PODIUM_RUN_MODE: 'detached' },
      execPath: '/opt/podium/podium',
      includeDaemon: false,
      spawnProcess,
      schedule: immediate,
    })

    restart?.()

    expect(spawnProcess.mock.calls.map((call) => call[1])).toEqual([
      ['janitor', '--server', 'http://127.0.0.1:19001', '--takeover'],
      ['server', '--takeover'],
    ])
  })

  it('asks systemd to restart the instance-scoped coordinator roles', () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }))
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'blue',
      port: () => 19001,
      env: { INVOCATION_ID: 'unit-run' },
      spawnProcess,
      schedule: immediate,
    })

    restart?.()

    expect(spawnProcess).toHaveBeenCalledWith(
      'systemctl',
      [
        '--user',
        '--no-block',
        'restart',
        'podium-blue-janitor.service',
        'podium-blue-server.service',
      ],
      { detached: true, stdio: 'ignore' },
    )
  })
})

describe('createInstalledCoordinatorUpdate', () => {
  it('delivers the exact target when a server-only installation has no local daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-server-update-'))
    try {
      writeFileSync(join(dir, 'VERSION'), '0.4.1\n')
      const deliver = vi.fn(async () => new Uint8Array([1, 2, 3]))
      const swap = vi.fn(async (_bytes: Uint8Array, installDir: string) => {
        writeFileSync(join(installDir, 'VERSION'), '0.4.2\n')
      })
      const ensure = createInstalledCoordinatorUpdate({
        env: { INVOCATION_ID: 'server-unit' },
        installDir: dir,
        deliver,
        swap,
        readApplied: () => undefined,
      })

      await ensure?.({ version: '0.4.2', critical: false, artifacts: {} })

      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ version: '0.4.2' }),
        '0.4.1',
        dir,
      )
      expect(swap).toHaveBeenCalledOnce()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does no delivery when the local daemon already swapped the shared bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-server-current-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'VERSION'), '0.4.2\n')
      const deliver = vi.fn()
      const ensure = createInstalledCoordinatorUpdate({
        env: { PODIUM_RUN_MODE: 'detached' },
        installDir: dir,
        deliver,
        readApplied: () => undefined,
      })
      await ensure?.({ version: '0.4.2', critical: false, artifacts: {} })
      expect(deliver).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a delivery that did not put the exact operation target on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-server-drift-'))
    try {
      writeFileSync(join(dir, 'VERSION'), '0.4.1\n')
      const ensure = createInstalledCoordinatorUpdate({
        env: { INVOCATION_ID: 'server-unit' },
        installDir: dir,
        deliver: async () => new Uint8Array([1]),
        readApplied: () => undefined,
        swap: async (_bytes, installDir) => {
          writeFileSync(join(installDir, 'VERSION'), '0.4.3\n')
        },
      })
      await expect(ensure?.({ version: '0.4.2', critical: false, artifacts: {} })).rejects.toThrow(
        /installed 0\.4\.3, expected 0\.4\.2/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a schema-regressing target before downloading or swapping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-server-schema-'))
    try {
      writeFileSync(join(dir, 'VERSION'), '0.4.2\n')
      const deliver = vi.fn(async () => new Uint8Array([1]))
      const swap = vi.fn(async () => {})
      const ensure = createInstalledCoordinatorUpdate({
        env: { INVOCATION_ID: 'server-unit' },
        installDir: dir,
        deliver,
        swap,
        readApplied: () => ['20260820000000_new-schema'],
      })

      await expect(
        ensure?.({
          version: '0.4.1',
          critical: false,
          artifacts: {},
          schema: { migrations: ['20260819000000_old-schema'] },
        }),
      ).rejects.toThrow(/schema-advanced/)
      expect(deliver).not.toHaveBeenCalled()
      expect(swap).not.toHaveBeenCalled()
      expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.4.2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
