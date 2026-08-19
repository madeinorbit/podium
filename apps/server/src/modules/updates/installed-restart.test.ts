import { describe, expect, it, vi } from 'vitest'
import { createInstalledCoordinatorRestart } from './installed-restart'

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
