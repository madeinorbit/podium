import { describe, expect, it } from 'vitest'
import { JanitorWorkerClient, type WorkerLike } from './worker-client'

type EventName = 'message' | 'error' | 'exit'
type Handler = (value: any) => void

function fakeWorker(): WorkerLike & {
  sent: unknown[]
  terminated: boolean
  emit(event: EventName, value: unknown): void
} {
  const handlers: Record<EventName, Handler[]> = { message: [], error: [], exit: [] }
  return {
    sent: [],
    terminated: false,
    postMessage(message) {
      this.sent.push(message)
    },
    on(event, callback) {
      handlers[event].push(callback)
    },
    terminate() {
      this.terminated = true
    },
    emit(event, value) {
      for (const handler of handlers[event]) handler(value)
    },
  }
}

async function drainTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('JanitorWorkerClient', () => {
  it('reports recovery and keeps progress monotonic across worker generations', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = []
    const logs: string[] = []
    const client = new JanitorWorkerClient(
      { serverUrl: 'http://server', token: 'token' },
      {
        spawn: () => {
          const worker = fakeWorker()
          workers.push(worker)
          return worker
        },
        log: (message) => logs.push(message),
      },
    )

    workers[0]!.emit('message', { type: 'ready', progressVersion: 4 })
    expect(client.state()).toBe('running')
    expect(client.progressVersion()).toBe(4)

    workers[0]!.emit('error', new Error('boom'))
    expect(client.state()).toBe('degraded')
    expect(logs).toContain('janitor worker failed: boom — restarting in 0ms')
    await drainTimers()
    expect(workers).toHaveLength(2)

    workers[1]!.emit('message', { type: 'ready', progressVersion: 2 })
    expect(client.state()).toBe('running')
    expect(client.restartCount()).toBe(1)
    expect(client.progressVersion()).toBe(6)
    client.close()
  })

  it('parks compatibility refusal visibly without respawning', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = []
    const client = new JanitorWorkerClient(
      { serverUrl: 'http://server', token: 'token' },
      {
        spawn: () => {
          const worker = fakeWorker()
          workers.push(worker)
          return worker
        },
        log: () => {},
      },
    )
    workers[0]!.emit('message', { type: 'ready', progressVersion: 1 })
    workers[0]!.emit('message', {
      type: 'compatibilityRefusal',
      reason: 'maintenance schema mismatch',
    })

    expect(client.state()).toBe('degraded')
    expect(client.reason()).toMatch(/schema mismatch/)
    expect(workers[0]!.terminated).toBe(true)
    await drainTimers()
    expect(workers).toHaveLength(1)
    client.close()
  })
})
