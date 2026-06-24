// apps/daemon/src/worker-client.test.ts
import { describe, expect, it } from 'vitest'
import { DiscoveryWorkerClient, type WorkerLike } from './worker-client.js'

type Handler = (a: any) => void

function makeFakeWorker() {
  const handlers: Record<'message' | 'error' | 'exit', Handler[]> = {
    message: [],
    error: [],
    exit: [],
  }
  const w: WorkerLike & { emit: (e: string, a: any) => void; sent: any[] } = {
    sent: [],
    postMessage(m: any) {
      this.sent.push(m)
    },
    on(ev, cb) {
      handlers[ev].push(cb)
    },
    terminate() {
      for (const h of handlers.exit) h(0)
    },
    emit(e, a) {
      for (const h of handlers[e as 'message' | 'error' | 'exit']) h(a)
    },
  }
  return w
}

describe('DiscoveryWorkerClient', () => {
  it('resolves a job when the worker replies', async () => {
    const fake = makeFakeWorker()
    const c = new DiscoveryWorkerClient({ spawn: () => fake })
    const p = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    const job = fake.sent[0]
    fake.emit('message', { id: job.id, ok: true, value: { agents: [], projects: [] } })
    await expect(p).resolves.toEqual({ agents: [], projects: [] })
    c.stop()
  })

  it('coalesces a second same-kind job into the first', async () => {
    const fake = makeFakeWorker()
    const c = new DiscoveryWorkerClient({ spawn: () => fake })
    const p1 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    const p2 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    expect(fake.sent.length).toBe(1)
    fake.emit('message', { id: fake.sent[0].id, ok: true, value: 7 })
    expect(await p1).toBe(7)
    expect(await p2).toBe(7)
    c.stop()
  })

  it("a stale job's finally does not clear a newer same-kind in-flight entry", async () => {
    let spawns = 0
    const workers: any[] = []
    const c = new DiscoveryWorkerClient({
      spawn: () => {
        spawns++
        const w = makeFakeWorker()
        workers.push(w)
        return w
      },
    })
    // Job 1 goes in-flight, then the worker crashes. crash() synchronously rejects
    // job 1's inner promise and clears `inflightByKind`, but job 1's `.finally`
    // (which deletes its own kind entry) is only queued as a microtask.
    const p1 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    p1.catch(() => {}) // swallow the crash rejection for the awaiter
    workers[0].emit('exit', 1)
    // Before draining microtasks, dispatch a NEW same-kind job. The map was cleared
    // by crash(), so this spawns a fresh worker and installs a NEW in-flight entry.
    const p2 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    expect(spawns).toBe(2)
    // Drain microtasks so job 1's now-STALE finally runs. The guard must make it a
    // no-op (the map holds p2, not p1); without the guard it would delete p2's entry.
    await Promise.resolve()
    await Promise.resolve()
    // p2's entry survived: a third same-kind call coalesces into the live p2.
    const p3 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    expect(p3).toBe(p2)
    expect(spawns).toBe(2) // p3 reused p2; no extra spawn/dispatch
    workers[1].emit('message', { id: workers[1].sent[0].id, ok: true, value: 9 })
    expect(await p2).toBe(9)
    expect(await p3).toBe(9)
    c.stop()
  })

  it('rejects in-flight jobs and respawns when the worker exits', async () => {
    let spawns = 0
    const workers: any[] = []
    const c = new DiscoveryWorkerClient({
      spawn: () => {
        spawns++
        const w = makeFakeWorker()
        workers.push(w)
        return w
      },
    })
    const p = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    workers[0].emit('exit', 1)
    await expect(p).rejects.toThrow()
    // next job triggers a fresh spawn
    void c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    expect(spawns).toBe(2)
    c.stop()
  })
})
