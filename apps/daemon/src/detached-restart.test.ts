import { describe, expect, it, vi } from 'vitest'
import { createDetachedRestart } from './detached-restart'

describe('createDetachedRestart', () => {
  it('is absent outside detached persistence', () => {
    expect(createDetachedRestart({ env: {} })).toBeUndefined()
  })

  it('spawns the same invocation before exiting the old daemon', () => {
    const unref = vi.fn()
    const spawnProcess = vi.fn(() => ({ unref }))
    const exit = vi.fn()
    const restart = createDetachedRestart({
      env: { PODIUM_RUN_MODE: 'detached', PODIUM_PORT: '18787' },
      execPath: '/opt/podium/podium',
      argv: ['/opt/podium/podium', 'daemon', '--local', '--takeover'],
      spawnProcess,
      exit,
    })

    restart?.()

    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/podium/podium',
      ['daemon', '--local', '--takeover'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({ PODIUM_RUN_MODE: 'detached', PODIUM_PORT: '18787' }),
      }),
    )
    expect(unref).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('hands off only once when two restart paths race', () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }))
    const restart = createDetachedRestart({
      env: { PODIUM_RUN_MODE: 'detached' },
      execPath: '/opt/podium/podium',
      argv: ['/opt/podium/podium', 'daemon', '--takeover'],
      spawnProcess,
      exit: vi.fn(),
    })

    restart?.()
    restart?.()

    expect(spawnProcess).toHaveBeenCalledOnce()
  })
})
