import { afterEach, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeEventOutbox } from './runtime-event-outbox'

/**
 * POD-7438 moved ACK fsyncs and compaction off the daemon thread. A SIGKILL in
 * the middle of a replay drain must still reopen exactly what the old
 * synchronous journal did: every event whose ACK had returned is retired (the
 * page cache survives a process kill), every unacknowledged event is still
 * pending, and nothing that was never enqueued appears.
 */
const roots: string[] = []
const children = new Set<ChildProcess>()
const total = 1_767 // POD-7414 section 3, the largest observed ACK burst.
const batch = 8

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }
  children.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function progressOf(dir: string) {
  const path = join(dir, 'progress.log')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  let acked = 0
  const added: string[] = []
  for (const line of lines) {
    const [verb, value] = line.split(' ')
    if (verb === 'acked') acked = Number(value)
    if (verb === 'added' && value) added.push(value)
  }
  return { acked, added }
}

async function killMidDrain(killAfterAcks: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-runtime-ack-crash-'))
  roots.push(dir)
  const child = spawn(
    'bun',
    [
      '--conditions=@podium/source',
      join(import.meta.dirname, 'fixtures/runtime-event-ack-drain-writer.ts'),
      dir,
      String(total),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  children.add(child)
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const deadline = Date.now() + 30_000
  while (progressOf(dir).acked < killAfterAcks) {
    if (child.exitCode !== null) throw new Error(`ack drain fixture exited early: ${stderr}`)
    if (Date.now() > deadline) throw new Error(`ack drain fixture stalled: ${stderr}`)
    await Bun.sleep(1)
  }
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  expect(await closed).toEqual([null, 'SIGKILL'])
  children.delete(child)
  return dir
}

describe('runtime event ACK drain across SIGKILL (POD-7438)', () => {
  it.each([
    300, 1_000, 1_600,
  ])('reopens the exact pending set after a kill past %i ACKs', async (killAfterAcks) => {
    const dir = await killMidDrain(killAfterAcks)
    const { acked, added } = progressOf(dir)
    expect(acked).toBeGreaterThanOrEqual(killAfterAcks)

    const outbox = createRuntimeEventOutbox(dir)
    try {
      const pending = new Set(outbox.pending().map((entry) => entry.deliveryId))
      const known = new Set([...Array.from({ length: total }, (_, i) => `backlog-${i}`), ...added])
      // The live event enqueued after the last reported batch, and the ACKs of the
      // batch after it, may have landed before the kill.
      known.add(`live-${acked}`)
      for (const id of pending) expect(known.has(id)).toBe(true)
      for (let i = 0; i < acked; i++) expect(pending.has(`backlog-${i}`)).toBe(false)
      for (let i = Math.min(total, acked + batch); i < total; i++)
        expect(pending.has(`backlog-${i}`)).toBe(true)
      for (const id of added) expect(pending.has(id)).toBe(true)

      // Replay after the crash is idempotent: draining the rest leaves nothing behind.
      for (const id of pending) expect(outbox.acknowledge(id)).toBe(true)
      for (const id of pending) expect(outbox.acknowledge(id)).toBe(false)
      await outbox.settled()
    } finally {
      outbox.close()
    }
    const drained = createRuntimeEventOutbox(dir)
    expect(drained.pending()).toEqual([])
    drained.close()
  }, 60_000)
})
