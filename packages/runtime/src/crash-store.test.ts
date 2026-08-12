import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CRASH_MAX_AGE_MS,
  CRASH_MAX_EVENTS,
  type CrashEventInput,
  createCrashStore,
} from './crash-store'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-crash-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const event = (message: string): CrashEventInput => ({
  origin: { role: 'web', v: '0.1.3', machineId: asMachineId('m1') },
  err: { name: 'TypeError', message, stack: 'at x (/app/x.ts:1:1)' },
  snapshot: [{ ts: '2026-08-11T14:03:22.847Z', level: 'debug', ns: 'web:x', msg: 'before' }],
})

/** A store whose clock the test drives, so retention is asserted rather than slept for. */
function storeAt(dir: string, clock: { ms: number }, overrides = {}) {
  let n = 0
  return createCrashStore({
    dir,
    now: () => clock.ms,
    id: () => {
      n += 1
      return `id${n}`
    },
    ...overrides,
  })
}

describe('the crash event store', () => {
  it('stores an event and reads it back whole, snapshot included', () => {
    const dir = tempDir()
    const clock = { ms: Date.parse('2026-08-11T14:03:22.847Z') }
    const store = storeAt(dir, clock)

    const written = store.record(event('boom'))

    expect(written?.receivedAt).toBe('2026-08-11T14:03:22.847Z')
    const [read] = store.list()
    expect(read).toEqual(written)
    expect(read?.snapshot).toHaveLength(1)
    expect(read?.origin.role).toBe('web')
  })

  it('lists newest first', () => {
    const dir = tempDir()
    const clock = { ms: Date.parse('2026-08-11T00:00:00.000Z') }
    const store = storeAt(dir, clock)

    store.record(event('first'))
    clock.ms += 60_000
    store.record(event('second'))
    clock.ms += 60_000
    store.record(event('third'))

    expect(store.list().map((e) => e.err.message)).toEqual(['third', 'second', 'first'])
  })

  it('keeps at most the newest 50 events', () => {
    const dir = tempDir()
    const clock = { ms: Date.parse('2026-08-11T00:00:00.000Z') }
    const store = storeAt(dir, clock)

    for (let i = 0; i < CRASH_MAX_EVENTS + 7; i++) {
      store.record(event(`crash-${i}`))
      clock.ms += 1000
    }

    const kept = store.list(1000)
    expect(kept).toHaveLength(CRASH_MAX_EVENTS)
    expect(kept[0]?.err.message).toBe(`crash-${CRASH_MAX_EVENTS + 6}`)
    // The oldest seven are GONE from disk, not merely unlisted.
    expect(readdirSync(dir)).toHaveLength(CRASH_MAX_EVENTS)
  })

  it('drops events older than 30 days even when far fewer than 50 are held', () => {
    const dir = tempDir()
    const clock = { ms: Date.parse('2026-01-01T00:00:00.000Z') }
    const store = storeAt(dir, clock)

    store.record(event('ancient'))
    clock.ms += CRASH_MAX_AGE_MS + 60_000
    store.record(event('recent'))

    expect(store.list().map((e) => e.err.message)).toEqual(['recent'])
  })

  it('never removes a file it did not write', () => {
    const dir = tempDir()
    const clock = { ms: Date.parse('2026-01-01T00:00:00.000Z') }
    const store = storeAt(dir, clock)
    store.record(event('one'))
    const bystander = join(dir, 'support-bundle.json')
    writeFileSync(bystander, '{}', 'utf8')

    clock.ms += CRASH_MAX_AGE_MS * 2
    store.prune()

    expect(readdirSync(dir)).toEqual(['support-bundle.json'])
  })

  it('skips an unparseable event instead of failing the read', () => {
    const dir = tempDir()
    const clock = { ms: Date.parse('2026-08-11T00:00:00.000Z') }
    const store = storeAt(dir, clock)
    store.record(event('good'))
    // A crash during a crash write leaves a truncated file behind.
    writeFileSync(join(dir, '20260811T000100000-trunc.json'), '{"err":', 'utf8')

    expect(store.list().map((e) => e.err.message)).toEqual(['good'])
  })

  it('reports a failed write instead of throwing at the ingestion endpoint', () => {
    // A path whose parent is a FILE: mkdir and write both fail, which is the
    // shape a full or read-only disk presents to this code.
    const dir = tempDir()
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x', 'utf8')
    const store = createCrashStore({ dir: join(blocked, 'crashes') })

    expect(store.record(event('boom'))).toBeUndefined()
    expect(store.list()).toEqual([])
  })
})
