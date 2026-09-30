/** N4, OpenCode 1.18.33: a kill after the 204 can lose the prompt or leave only its message row. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { readOpencodePromptHistory } from '../../../store/sources/sqlite.js'
import evidence from './__fixtures__/receipt-proof-v1.json' with { type: 'json' }
import { deltaItemIdForPart } from './map.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const options = { origin: 'human', delivery: 'when-ready' } as const
const measured = evidence.scenarios.killed
const messageID = measured.request.messageID
const part = measured.request.parts[0]!
const input = { id: messageID, rowId: messageID, text: part.text }

async function fixture(waitMs = 10_000) {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-exit-proof-'))
  const databasePath = join(directory, 'opencode.db')
  const db = openDatabase(databasePath)
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)')
  let exited = false
  let acknowledge!: () => void
  const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve })
  const host = makeOpencodeTestHost({
    wrapClient: (client) => ({
      ...client,
      // The HTTP history and SSE missed the stored part before the server died.
      messages: async () => [],
      async prompt(sessionId, body) {
        const result = await client.prompt(sessionId, body)
        acknowledge()
        return result
      },
    }),
  })
  host.promptRecordTimeoutMs = waitMs
  const launch = host.launch.bind(host)
  const read = vi.fn((sessionId: string) => {
    expect(exited, 'history must be read after the observed process exit').toBe(true)
    return readOpencodePromptHistory({ sessionId, databasePath })
  })
  host.launch = async (launchInput) => ({
    ...await launch(launchInput),
    databasePath,
    engineExit: () => exited ? { code: 0, signal: 9 } : undefined,
    readHistoryAfterExit: read,
  })
  const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
  const spec: SessionSpec = {
    harness: 'opencode',
    selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
    workdir: directory,
    model: {},
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
  }
  const handle = await runtime.driver.create(spec)
  const server = host.serverFor(handle.binding.sessionId)!
  server.omitNextPromptRecord()
  const sessionID = handle.binding.resume!.value
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of handle.events('bootstrap')) events.push(event)
  })()
  const record = (withPart: boolean, partId = part.id, id = messageID, nativeSession = sessionID) => {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, nativeSession, JSON.stringify({ role: 'user' }), 1)
    if (withPart)
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(partId, nativeSession, id, JSON.stringify(part), 1, 1)
  }
  return {
    handle, server, host, sessionID, db, read, acknowledged, record,
    deliveries: () => events.filter((event) => event.t === 'delivery'),
    async die(observed = true) {
      await acknowledged
      exited = observed
      await server.close()
      await expect.poll(() => events.some((event) => event.t === 'process' && event.ev.ev === 'exited'), { timeout: 8000 }).toBe(true)
    },
    cleanup() {
      runtime.dispose()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

describe('v1 exit proof from the final local history', () => {
  it.each([false, true])('fails a missing text part after SIGKILL, with a surviving message row: %s', async (rowSurvives) => {
    expect(measured.status).toBe(204)
    expect(measured.part).toBeNull()
    const f = await fixture()
    const lost = vi.fn()
    const late = vi.fn()
    try {
      await f.handle.send(input, { ...options, onUnrecorded: lost, onLateProof: late })
      await f.acknowledged
      if (rowSurvives) f.record(false)
      await f.die()
      await expect.poll(() => f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'agent-exited' }])
      expect(lost).toHaveBeenCalledExactlyOnceWith('the agent program exited without recording it', 'agent-exited')
      expect(late).not.toHaveBeenCalled()
      expect(f.read).toHaveBeenCalledExactlyOnceWith(f.sessionID)
    } finally { f.cleanup() }
  })

  it('names the stored text part after SIGKILL even when it lies beyond the normal 8000-part tail', async () => {
    const f = await fixture()
    const lost = vi.fn()
    try {
      await f.handle.send(input, { ...options, onUnrecorded: lost })
      await f.acknowledged
      f.record(true)
      f.db.exec('BEGIN')
      const insertMessage = f.db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      const insertPart = f.db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
      for (let i = 0; i < 8001; i++) {
        insertMessage.run(`other-${i}`, f.sessionID, '{"role":"assistant"}', i + 2)
        insertPart.run(`other-part-${i}`, f.sessionID, `other-${i}`, '{"type":"text","text":"later"}', i + 2, i + 2)
      }
      f.db.exec('COMMIT')
      await f.die()
      await expect.poll(() => f.deliveries()).toMatchObject([{
        outcome: 'delivered',
        transcriptItem: { id: deltaItemIdForPart(f.sessionID, part.id), cursor: expect.any(String) },
        harnessRef: [{ kind: 'opencode-message', id: messageID }, { kind: 'opencode-part', id: part.id }],
      }])
      expect(lost).not.toHaveBeenCalled()
      expect(f.host.bindings.recorded(f.handle.binding.sessionId)?.databasePath).toBe(f.handle.binding.workdir + '/opencode.db')
    } finally { f.cleanup() }
  })

  it.each([false, true])('settles a late post-exit proof after the receipt became unverified; text survives: %s', async (textSurvives) => {
    const f = await fixture(30)
    const lost = vi.fn()
    try {
      await f.handle.send(input, { ...options, onUnrecorded: lost })
      await expect.poll(() => f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'unconfirmed' }])
      if (textSurvives) f.record(true)
      await f.die()
      await expect.poll(() => f.deliveries()).toHaveLength(2)
      expect(f.deliveries()[1]).toMatchObject(textSurvives
        ? { outcome: 'delivered', transcriptItem: { id: deltaItemIdForPart(f.sessionID, part.id) } }
        : { outcome: 'failed', cause: 'agent-exited' })
      expect(lost).toHaveBeenCalledTimes(textSurvives ? 0 : 1)
    } finally { f.cleanup() }
  })

  it.each(['other-part', 'other-message', 'other-session'] as const)('does not confirm an unrelated row with the same text: %s', async (kind) => {
    const f = await fixture()
    try {
      await f.handle.send(input, options)
      await f.acknowledged
      f.record(true, kind === 'other-part' ? 'prt_other' : part.id, kind === 'other-message' ? 'msg_other' : messageID, kind === 'other-session' ? 'ses_other' : f.sessionID)
      await f.die()
      await expect.poll(() => f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'agent-exited' }])
    } finally { f.cleanup() }
  })

  it.each(['missing-file', 'broken-schema', 'invalid-json'] as const)('leaves an unreadable store unconfirmed: %s', async (kind) => {
    const f = await fixture(30)
    const lost = vi.fn()
    try {
      await f.handle.send(input, { ...options, onUnrecorded: lost })
      await expect.poll(() => f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'unconfirmed' }])
      if (kind === 'missing-file') rmSync(join(f.handle.binding.workdir, 'opencode.db'))
      if (kind === 'broken-schema') f.db.exec('DROP TABLE part')
      if (kind === 'invalid-json') {
        f.record(true)
        f.db.prepare('UPDATE part SET data = ?').run('{')
      }
      await f.die()
      expect(f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'unconfirmed' }])
      expect(lost).not.toHaveBeenCalled()
      expect(f.read).toHaveBeenCalledOnce()
    } finally { f.cleanup() }
  })

  it('does not infer an exit proof from HTTP and SSE failure alone', async () => {
    const f = await fixture(30)
    const lost = vi.fn()
    try {
      await f.handle.send(input, { ...options, onUnrecorded: lost })
      await expect.poll(() => f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'unconfirmed' }])
      await f.die(false)
      expect(f.read).not.toHaveBeenCalled()
      expect(lost).not.toHaveBeenCalled()
      expect(f.deliveries()).toHaveLength(1)
    } finally { f.cleanup() }
  })
})
