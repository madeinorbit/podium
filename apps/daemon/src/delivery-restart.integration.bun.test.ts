import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { withDeliveryQueue, type AgentSessionHandle, type RuntimeEventBody, type SendOptions, type TurnInput } from '@podium/harness/driver/host'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createRuntimeEventOutbox, prepareRuntimeEventDelivery, type RuntimeEventOutbox } from './runtime-event-outbox'

const roots: string[] = []
const children = new Set<ChildProcess>()
const outboxes = new Set<RuntimeEventOutbox>()
const sessionId = asSessionId('restart-session')
const input = { id: 'held-mail', rowId: 'held-mail', text: 'send after the turn', deliveryRecovery: true }
const options = { origin: 'mail', delivery: 'when-ready' } as const

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }
  children.clear()
  for (const outbox of outboxes) outbox.close()
  outboxes.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function open(dir: string): RuntimeEventOutbox {
  const outbox = createRuntimeEventOutbox(dir)
  outboxes.add(outbox)
  return outbox
}

async function crash(mode: 'held' | 'typing' | 'outcome'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-delivery-restart-'))
  roots.push(dir)
  const child = spawn('bun', ['--conditions=@podium/source',
    join(import.meta.dirname, 'fixtures/delivery-journal-crash-writer.ts'), dir, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = ''
  let stderr = ''
  const marker = mode === 'held' ? 'held-untyped' : `${mode}-durable`
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`delivery fixture did not reach ${marker}: ${stderr}`)), 10_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', () => {
      if (!stdout.includes(marker)) { clearTimeout(timeout); reject(new Error(`delivery fixture exited: ${stderr}`)) }
    })
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes(marker)) { clearTimeout(timeout); resolve() }
    })
  })
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  expect(await closed).toEqual([null, 'SIGKILL'])
  children.delete(child)
  return dir
}

function owner(outbox: RuntimeEventOutbox) {
  let phase = 'working'
  let seq = 0
  const emit = mock((event: RuntimeEventBody) => {
    prepareRuntimeEventDelivery(outbox, { type: 'runtimeEvent', sessionId,
      event: { ...event, at: new Date().toISOString(), provenance: 'live',
        cursor: { segmentId: 'after-restart', components: { seq: ++seq } }, observerGeneration: 2, turnEpoch: 1 },
    })
  })
  const write = mock(async (_input: TurnInput, options: SendOptions) => {
    options.onTypingStarted?.()
    return { outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready',
      provenBy: 'protocol-ack', at: new Date().toISOString(), transcriptItem: { id: 'recorded-entry' } }
  })
  const handle = withDeliveryQueue({ send: write, state: async () => ({ phase }), stop: async () => {} } as unknown as AgentSessionHandle,
    emit, undefined, undefined, outbox.deliveryJournal(sessionId))
  return { handle, write, emit, idle: () => { phase = 'idle' } }
}

describe('daemon delivery journal across SIGKILL (POD-5556)', () => {
  it('never retries a recovery reserved before the legacy outbox gained typing coverage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-delivery-upgrade-'))
    roots.push(dir)
    writeFileSync(join(dir, 'runtime-event-outbox.json'), JSON.stringify({ version: 1, events: [] }))
    const after = owner(open(dir))
    after.idle()
    await after.handle.send(input, options)
    await Bun.sleep(250)
    expect(after.write).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    await after.handle.stop()
  }, 20_000)

  it('never retries a recovery after both journal files were deleted between owners', async () => {
    const dir = await crash('typing')
    for (const name of ['runtime-event-outbox.json', 'runtime-event-outbox.log']) rmSync(join(dir, name), { force: true })
    const after = owner(open(dir))
    after.idle()
    await after.handle.send(input, options)
    await Bun.sleep(250)
    expect(after.write).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    await after.handle.stop()
  }, 20_000)

  it('never trusts stored-only recovery coverage before a torn typing record', async () => {
    const dir = await crash('typing')
    const path = join(dir, 'runtime-event-outbox.log')
    const journal = readFileSync(path, 'utf8')
    const marker = journal.lastIndexOf('{"op":"typing"')
    expect(marker).toBeGreaterThanOrEqual(0)
    writeFileSync(path, journal.slice(0, marker) + '{"op":"typing"')
    const after = owner(open(dir))
    after.idle()
    await after.handle.send(input, options)
    await Bun.sleep(250)
    expect(after.write).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    await after.handle.stop()
  }, 20_000)

  it('never trusts an older stored snapshot when its later typing log was deleted', async () => {
    const dir = await crash('held')
    const before = open(dir)
    // The next compaction still says stored, never typed. The subsequent
    // first-byte fence exists only in the append log that is then lost.
    for (let index = 0; index < 511; index++) before.deliveryJournal(sessionId).start(`other-${index}`)
    before.deliveryJournal(sessionId).start(input.rowId)
    before.close()
    rmSync(join(dir, 'runtime-event-outbox.log'))
    const after = owner(open(dir))
    after.idle()
    await after.handle.send(input, options)
    await Bun.sleep(250)
    expect(after.write).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    await after.handle.stop()
  }, 20_000)

  it('holds never-typed mail on the new owner, then types it exactly once at idle', async () => {
    const dir = await crash('held')
    const outbox = open(dir)
    expect(outbox.deliveryJournal(sessionId).read(input.rowId)).toEqual({ typingStarted: false })
    const after = owner(outbox)
    await after.handle.send(input, options)
    await Bun.sleep(400)
    expect(after.emit).not.toHaveBeenCalled()
    expect(after.write).not.toHaveBeenCalled()
    after.idle()
    await Bun.sleep(250)
    await after.handle.send(input, options)
    expect(after.write).toHaveBeenCalledTimes(1)
    expect(after.emit.mock.calls.every(([event]) => event.t === 'delivery' && event.outcome === 'delivered')).toBe(true)
    await after.handle.stop()

    outbox.close()
    const nextOwner = owner(open(dir))
    await nextOwner.handle.send(input, options)
    expect(nextOwner.write).not.toHaveBeenCalled()
    expect(nextOwner.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'delivered', transcriptItem: { id: 'recorded-entry' } }))
    await nextOwner.handle.stop()
  }, 20_000)

  it('keeps a write started before SIGKILL unconfirmed and never types it twice', async () => {
    const dir = await crash('typing')
    const outbox = open(dir)
    expect(outbox.deliveryJournal(sessionId).read(input.rowId)).toEqual({ typingStarted: true })
    const after = owner(outbox)
    after.idle()
    await after.handle.send(input, options)
    await Bun.sleep(250)
    expect(after.write).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    await after.handle.stop()
  }, 20_000)

  it('re-reports a recorded outcome after SIGKILL without typing', async () => {
    const dir = await crash('outcome')
    const after = owner(open(dir))
    await after.handle.send(input, options)
    expect(after.write).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'delivered', transcriptItem: { id: 'recorded-entry' } }))
    await after.handle.stop()
  }, 20_000)

  it('keeps concurrent instance journals independent for the same session and row ids', async () => {
    const typedDir = await crash('typing')
    const heldDir = await crash('held')
    const typed = owner(open(typedDir))
    const held = owner(open(heldDir))
    typed.idle()
    held.idle()
    await Promise.all([typed.handle.send(input, options), held.handle.send(input, options)])
    await Bun.sleep(250)
    expect(typed.write).not.toHaveBeenCalled()
    expect(typed.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    expect(held.write).toHaveBeenCalledTimes(1)
    expect(held.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'delivered' }))
    await typed.handle.stop()
    await held.handle.stop()
  }, 20_000)
})
