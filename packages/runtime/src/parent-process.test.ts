import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ParentProcess, type SpawnChildFn } from './parent-process'
import type { HandoverHealthProbe } from './parent-supervisor'

class FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null = null
  killed = false
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  kill(signal?: string): boolean {
    this.killed = true
    this.exitCode = signal === 'SIGKILL' ? null : 0
    this.emit('exit', this.exitCode, signal === 'SIGTERM' ? null : signal)
    return true
  }
  unref(): void {}
}

describe('ParentProcess', () => {
  it('spawns server before daemon from the install invocation', async () => {
    const spawned: Array<{ cmd: string; args: readonly string[] }> = []
    let nextPid = 100
    const spawnImpl: SpawnChildFn = (cmd, args) => {
      spawned.push({ cmd, args })
      const child = new FakeChild(nextPid++)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const probe: HandoverHealthProbe = {
      serverRunning: true,
      daemonRunning: true,
      serverVersion: '1.0.0',
      daemonConnected: true,
    }
    const notifications: string[] = []
    const parent = new ParentProcess({
      port: 19099,
      installDir: '/opt/podium',
      installBinary: '/opt/podium/podium',
      env: { PODIUM_APP_VERSION: '1.0.0' },
      spawn: spawnImpl,
      probeHealth: async () => probe,
      notify: (s) => notifications.push(s),
      sleep: async () => {},
      now: () => 1_000,
    })

    await parent.start()

    expect(spawned.map((s) => s.args[0])).toEqual(['server', 'daemon'])
    expect(spawned[0]?.cmd).toBe('/opt/podium/podium')
    expect(notifications).toContain('READY=1')
    expect(parent.snapshot().children.server.status).toBe('running')
    expect(parent.snapshot().children.daemon.status).toBe('running')
    await parent.stop()
  })

  it('hands over: spawns successor, waits for healthy /version+daemon, notifies MAINPID', async () => {
    let nextPid = 200
    const spawnImpl: SpawnChildFn = () => {
      const child = new FakeChild(nextPid++)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    let healthy = false
    const notifications: string[] = []
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const parent = new ParentProcess({
      port: 19099,
      installDir: '/opt/podium',
      installBinary: '/opt/podium/podium',
      env: { PODIUM_APP_VERSION: '1.0.0' },
      spawn: spawnImpl,
      probeHealth: async () =>
        healthy
          ? {
              serverRunning: true,
              daemonRunning: true,
              serverVersion: '2.0.0',
              daemonConnected: true,
            }
          : {
              serverRunning: true,
              daemonRunning: true,
              serverVersion: '1.0.0',
              daemonConnected: true,
            },
      notify: (s) => notifications.push(s),
      sleep: async () => {
        healthy = true
      },
      now: (() => {
        let t = 0
        return () => (t += 100)
      })(),
    })

    await parent.start()
    await parent.handover('2.0.0')

    expect(notifications.some((n) => n.startsWith('MAINPID='))).toBe(true)
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('schedules crash restart with backoff instead of leaving the child dead', async () => {
    let nextPid = 300
    const serverKids: FakeChild[] = []
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
      if (args[0] === 'server') serverKids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const parent = new ParentProcess({
      port: 19099,
      installBinary: '/opt/podium/podium',
      env: { PODIUM_APP_VERSION: '1.0.0' },
      children: ['server'],
      spawn: spawnImpl,
      probeHealth: async () => ({
        serverRunning: true,
        daemonRunning: false,
        serverVersion: '1.0.0',
        daemonConnected: false,
      }),
      notify: () => {},
      sleep: async () => {},
      now: () => 5_000,
    })
    await parent.start()
    expect(serverKids).toHaveLength(1)
    serverKids[0]!.emit('exit', 1, null)
    expect(parent.snapshot().children.server.status).toBe('restarting')
    await parent.stop()
  })
})
