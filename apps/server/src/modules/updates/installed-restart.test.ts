import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createInstalledCoordinatorRestart,
  createInstalledCoordinatorUpdate,
} from './installed-restart'

describe('createInstalledCoordinatorRestart', () => {
  it('is absent without a real restart authority', () => {
    expect(
      createInstalledCoordinatorRestart({ instanceId: 'default', port: () => 18787, env: {} }),
    ).toBeUndefined()
  })

  it('asks the supervising parent to self-handover after a detached swap', () => {
    const requestHandover = vi.fn(() => ({ ok: true as const, pid: 99 }))
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'default',
      port: () => 19001,
      env: { PODIUM_RUN_MODE: 'detached', PODIUM_APP_VERSION: '0.4.2' },
      requestHandover,
      pendingVersion: () => '0.4.2',
    })

    restart?.()

    expect(requestHandover).toHaveBeenCalledWith('0.4.2')
  })

  it('asks the supervising parent under systemd the same way (no systemctl restart)', () => {
    const requestHandover = vi.fn(() => ({ ok: true as const, pid: 7 }))
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'blue',
      port: () => 19001,
      env: { INVOCATION_ID: 'unit-run', PODIUM_APP_VERSION: '1.0.0' },
      requestHandover,
      pendingVersion: () => '1.0.0',
    })

    restart?.()

    expect(requestHandover).toHaveBeenCalledWith('1.0.0')
  })

  it('refuses with machine-cannot-restart when no parent is registered', () => {
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'default',
      port: () => 19001,
      env: { PODIUM_UNDER_PARENT: '1', PODIUM_APP_VERSION: '1.0.0' },
      requestHandover: () => ({ ok: false, reason: 'no-parent' }),
      pendingVersion: () => '1.0.0',
    })

    expect(() => restart?.()).toThrow(/machine-cannot-restart/)
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

  it('is available under PODIUM_UNDER_PARENT without legacy markers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-under-parent-'))
    try {
      writeFileSync(join(dir, 'VERSION'), '1.0.0\n')
      const ensure = createInstalledCoordinatorUpdate({
        env: { PODIUM_UNDER_PARENT: '1' },
        installDir: dir,
        deliver: async () => new Uint8Array(),
        readApplied: () => undefined,
      })
      expect(ensure).toBeTypeOf('function')
      await ensure?.({ version: '1.0.0', critical: false, artifacts: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
