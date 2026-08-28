import { asThreadId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JanitorWorkerClient } from '../apps/janitor/src/worker-client'
import { startServer, type ServerHandle } from '../apps/server/src/server'
import { SessionStore, type MessageRow } from '../apps/server/src/store'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function messageStatus(dbPath: string): string | undefined {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    return (
      db.prepare("SELECT status FROM messages WHERE id = 'msg_worker_due'").get() as
        | { status: string }
        | undefined
    )?.status
  } finally {
    db.close()
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

async function requestSamples(url: string, count: number): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i += 1) {
    const started = performance.now()
    const response = await fetch(url)
    await response.text()
    expect(response.status).toBe(200)
    samples.push(performance.now() - started)
  }
  return samples
}

describe('server-owned janitor worker', () => {
  it('does real work, isolates request latency, and recovers a crash and a wedge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-worker-'))
    const dbPath = join(dir, 'podium.db')
    const priorStateDir = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    let server: ServerHandle | undefined
    let worker: JanitorWorkerClient | undefined
    const workerLogs: string[] = []

    try {
      const seed = new SessionStore(dbPath)
      const message: MessageRow = {
        id: 'msg_worker_due',
        threadId: asThreadId('thread_worker_due'),
        inReplyTo: null,
        fromKind: 'system',
        fromSession: null,
        fromName: 'test',
        fromIssue: null,
        toKind: 'operator',
        toId: null,
        kind: 'notification',
        urgency: 'fyi',
        lifecycle: 'wait',
        body: 'due',
        expiresAt: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-06-30T00:00:00.000Z',
        status: 'queued',
        deliveredAt: null,
        deliveredTo: null,
        ackedBy: null,
        hop: 0,
        clampedFrom: null,
        remindedAt: null,
        factKey: null,
        factTarget: null,
        expectsResponse: false,
      }
      seed.messages.addMessage(message)
      seed.close()

      server = await startServer({
        port: 0,
        startJanitorWorker: async (options) => {
          worker = new JanitorWorkerClient(
            { ...options, dbPath, tickMs: 100 },
            {
              monitorMs: 25,
              wedgedMs: 1_500,
              log: (entry) => workerLogs.push(entry),
            },
          )
          return worker
        },
      })
      await waitFor(() => worker?.state() === 'running', 'janitor worker did not start')
      expect(messageStatus(dbPath)).toBe('expired')

      const healthUrl = `http://127.0.0.1:${server.port}/health`
      const baseline = await requestSamples(healthUrl, 20)
      const blockMs = 600

      // Historical inline control: a request issued immediately before the server
      // event loop is blocked cannot complete until the block ends.
      const inlineStarted = performance.now()
      const inlineRequest = fetch(healthUrl)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs)
      const inlineResponse = await inlineRequest
      await inlineResponse.text()
      const inlineBlockRequestMs = performance.now() - inlineStarted

      const isolatedBlock = worker!.blockForTest(blockMs)
      await isolatedBlock.started
      const duringWorkerBlock = await requestSamples(healthUrl, 20)
      await isolatedBlock.done

      const baselineP95Ms = percentile(baseline, 0.95)
      const workerBlockP95Ms = percentile(duringWorkerBlock, 0.95)
      console.log(
        `[janitor-worker-isolation] ${JSON.stringify({
          blockMs,
          baselineP95Ms: Number(baselineP95Ms.toFixed(2)),
          inlineBlockRequestMs: Number(inlineBlockRequestMs.toFixed(2)),
          workerBlockP95Ms: Number(workerBlockP95Ms.toFixed(2)),
        })}`,
      )
      expect(inlineBlockRequestMs).toBeGreaterThan(blockMs * 0.8)
      expect(workerBlockP95Ms).toBeLessThan(inlineBlockRequestMs / 2)
      expect(workerBlockP95Ms).toBeLessThan(Math.max(200, baselineP95Ms * 20))

      const progressBeforeCrash = worker!.progressVersion()
      worker!.crashForTest()
      await waitFor(
        () => workerLogs.some((entry) => entry.includes('deliberate janitor worker crash')),
        'worker crash was not logged',
      )
      await waitFor(
        () => worker!.restartCount() >= 1 && worker!.state() === 'running',
        'worker did not recover from crash',
      )
      expect(worker!.progressVersion()).toBeGreaterThan(progressBeforeCrash)

      const wedged = worker!.blockForTest(3_000)
      await wedged.started
      void wedged.done.catch(() => {})
      await waitFor(
        () => workerLogs.some((entry) => entry.includes('worker wedged')),
        'worker wedge was not logged',
      )
      await waitFor(
        () => worker!.restartCount() >= 2 && worker!.state() === 'running',
        'worker did not recover from wedge',
      )

      const version = (await fetch(`http://127.0.0.1:${server.port}/version`).then((r) =>
        r.json(),
      )) as { components?: { janitor?: { state?: string; progressVersion?: number } } }
      expect(version.components?.janitor?.state).toBe('running')
      expect(version.components?.janitor?.progressVersion).toBeGreaterThan(0)
    } finally {
      await server?.close()
      worker?.close()
      if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = priorStateDir
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('embeds and loads the janitor worker in a compiled Bun binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-worker-compile-'))
    const binary = join(dir, 'janitor-worker-smoke')
    try {
      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--conditions=@podium/source',
          'scripts/janitor-worker-smoke.ts',
          'apps/janitor/src/janitor-worker.ts',
          '--outfile',
          binary,
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )
      const output = execFileSync(binary, { encoding: 'utf8', timeout: 20_000 })
      expect(output).toContain('SMOKE_OK')
      expect(output).not.toContain('ModuleNotFound')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
