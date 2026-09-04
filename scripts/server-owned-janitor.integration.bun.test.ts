/**
 * Every server owns a janitor — including a bare one (PDM-27).
 *
 * The regression this exists to catch is the one the old shape actually had:
 * whether the janitor ran depended on a four-way env/mode gate in the CLI
 * launcher, so `podium server` — and `scripts/server.ts`, and any new
 * composition root that forgot the injection — served requests with no
 * maintenance loop at all, silently and indefinitely.
 *
 * So this boots the REAL thing: `startServer` with no test seam, no injection,
 * no environment, and asserts that maintenance actually happened — a due message
 * expires, a fenced lease is held, and `/version` reports the component running
 * with a nonzero progress token. A unit test with a stubbed worker cannot answer
 * that; only starting the thread can.
 *
 * RUNNER: `bun test --conditions=@podium/source
 * scripts/server-owned-janitor.integration.bun.test.ts` — it is in the `test:bun`
 * lane, not the vitest integration lane, because spawning a real worker_thread
 * inside a vitest fork under Bun crashes the runner (the same reason
 * scripts/janitor-worker.integration.test.ts is hard to run locally). Bun's own
 * runner hosts the thread the way production does.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asThreadId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'bun:test'
import { type ServerHandle, startServer } from '../apps/server/src/server'
import { type MessageRow, SessionStore } from '../apps/server/src/store'

interface JanitorComponent {
  state?: string
  progressVersion?: number
  reason?: string
}

async function janitorComponent(port: number): Promise<JanitorComponent | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/version`)
  const body = (await response.json()) as { components?: { janitor?: JanitorComponent } }
  return body.components?.janitor
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (last !== undefined) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function dueMessage(): MessageRow {
  return {
    id: 'msg_due',
    threadId: asThreadId('thread_due'),
    inReplyTo: null,
    fromKind: 'system',
    fromSession: null,
    fromName: 'server-owned-janitor',
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
}

function readOnly<T>(dbPath: string, read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

describe('a bare server hosts its own janitor [PDM-27]', () => {
  it('starts the worker, holds the fenced lease, and reports it on /version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-server-owned-janitor-'))
    const dbPath = join(dir, 'podium.db')
    const priorStateDir = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    let server: ServerHandle | undefined

    try {
      const seed = new SessionStore(dbPath)
      seed.messages.addMessage(dueMessage())
      seed.close()

      // No `janitorWorkerForTests`, no injection, no env: exactly what a plain
      // `podium server` — or any other composition root — constructs.
      server = await startServer({ port: 0 })
      const port = server.port

      const running = await waitFor(async () => {
        const janitor = await janitorComponent(port)
        return janitor?.state === 'running' ? janitor : undefined
      }, 'the janitor to report running on /version')
      expect(running.state).toBe('running')
      expect(running.reason).toBeUndefined()
      expect(running.progressVersion).toBeGreaterThan(0)

      // The loop really ran against the real database, through the authenticated
      // /maintenance seam rather than a direct write.
      const status = await waitFor(
        async () =>
          readOnly(
            dbPath,
            (db) =>
              (
                db.prepare("SELECT status FROM messages WHERE id = 'msg_due'").get() as
                  | { status: string }
                  | undefined
              )?.status,
          ) === 'expired'
            ? 'expired'
            : undefined,
        'the due message to expire',
      )
      expect(status).toBe('expired')

      // One janitor, fenced: the lease is what makes a second one harmless.
      const lease = readOnly(
        dbPath,
        (db) =>
          db
            .prepare('SELECT generation_id FROM maintenance_leases WHERE name = ?')
            .get('janitor') as { generation_id: string } | undefined,
      )
      expect(lease?.generation_id).toMatch(/^janitor_/)
    } finally {
      await server?.close()
      if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = priorStateDir
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
