import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { startJanitor, type JanitorHandle } from '../apps/janitor/src/janitor'
import { startServer, type ServerHandle } from '../apps/server/src/server'
import { SessionStore, type MessageRow } from '../apps/server/src/store'

function messageStatus(dbPath: string): string | undefined {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    return (
      db.prepare("SELECT status FROM messages WHERE id = 'msg_due'").get() as
        | { status: string }
        | undefined
    )?.status
  } finally {
    db.close()
  }
}

function expiredEventCount(dbPath: string): number {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM podium_events WHERE kind = 'message.expired' AND subject = 'msg_due'",
        )
        .get() as { n: number }
    ).n
  } finally {
    db.close()
  }
}

describe('janitor process recovery [spec:SP-c29e]', () => {
  it('delays expiry while down, then applies it once through the authenticated server seam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-recovery-'))
    const dbPath = join(dir, 'podium.db')
    const priorStateDir = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    let server: ServerHandle | undefined
    let janitor: JanitorHandle | undefined

    try {
      const seed = new SessionStore(dbPath)
      const message: MessageRow = {
        id: 'msg_due',
        threadId: 'thread_due',
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

      expect(messageStatus(dbPath)).toBe('queued')
      server = await startServer({ port: 0 })
      janitor = await startJanitor({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: server.bootstrapToken,
        dbPath,
      })

      expect(messageStatus(dbPath)).toBe('expired')
      await janitor.service.tick()
      expect(expiredEventCount(dbPath)).toBe(1)
    } finally {
      janitor?.close()
      await server?.close()
      if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = priorStateDir
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
