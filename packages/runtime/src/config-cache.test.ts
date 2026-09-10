/**
 * The stat-invalidated config cache (POD-3840).
 *
 * `loadConfig` was a file read, a JSON parse, a migration pass, a zod validation
 * AND a second read of `instance.json` — on EVERY call, in a server that calls it
 * once per machine per machine listing. These tests pin the cache that replaces
 * all of that with one `statSync`, and the invalidation rules that keep every
 * reader as fresh as it was before.
 *
 * `readFileSync` is counted through a PARTIAL module mock — the real function
 * still does the work, so what is asserted is "the loader did not open the file",
 * not a mock's own behavior.
 */
import { vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, type LogRecord } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONFIG_CACHE_MAX_PATHS,
  inspectConfig,
  loadConfig,
  onConfigChanged,
  type PodiumConfig,
  saveConfig,
} from './config'

/** Reads of ONE path, so the harness's own file writing is not counted. */
function readsOf(path: string): number {
  return vi.mocked(readFileSync).mock.calls.filter((call) => call[0] === path).length
}

/**
 * Age a file out of the racy-timestamp window.
 *
 * The kernel stamps mtime from a 1 ms-granular clock (measured on this box:
 * six back-to-back same-size writes share ONE mtime), so a file written this
 * millisecond cannot be told apart from its own next rewrite. The loader
 * refuses to cache inside that window, and a test that wants a cache HIT has to
 * put the write far enough in the past that a later write would have to differ.
 */
function backdate(path: string, secondsAgo = 60): void {
  const when = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(path, when, when)
}

describe('config cache (POD-3840)', () => {
  let dir: string
  let priorStateDir: string | undefined
  let path: string

  beforeEach(() => {
    priorStateDir = process.env.PODIUM_STATE_DIR
    dir = mkdtempSync(join(tmpdir(), 'podium-cfg-cache-'))
    process.env.PODIUM_STATE_DIR = dir
    path = join(dir, 'config.json')
    vi.mocked(readFileSync).mockClear()
  })

  afterEach(() => {
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves a second load of an unchanged file from cache, without reading it', () => {
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)

    const first = loadConfig(path)
    const readsAfterFirst = readsOf(path)
    const second = loadConfig(path)

    expect(readsAfterFirst).toBe(1)
    expect(readsOf(path)).toBe(1)
    expect(second).toBe(first)
    expect(second).toEqual(expect.objectContaining({ mode: 'server', port: 18787 }))
  })

  it('re-reads when a rewrite changes the mtime', () => {
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)
    expect(loadConfig(path).port).toBe(18787)

    writeFileSync(path, JSON.stringify({ mode: 'server', port: 19999 }))
    backdate(path, 30)

    expect(loadConfig(path).port).toBe(19999)
    expect(readsOf(path)).toBe(2)
  })

  it('re-reads when the size changes under an unchanged mtime', () => {
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)
    const pinned = statSync(path)
    expect(loadConfig(path).port).toBe(18787)

    // A LONGER body, then the ORIGINAL mtime restored: only `size` can tell
    // these two files apart.
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787, serverUrl: 'ws://a:1' }))
    utimesSync(path, pinned.atime, pinned.mtime)

    expect(loadConfig(path).serverUrl).toBe('ws://a:1')
    expect(readsOf(path)).toBe(2)
  })

  it('re-reads when the inode changes under an unchanged mtime and size', () => {
    const body = JSON.stringify({ mode: 'server', port: 18787 })
    const replacement = JSON.stringify({ mode: 'server', port: 19999 })
    expect(replacement).toHaveLength(body.length)

    writeFileSync(path, body)
    backdate(path)
    const pinned = statSync(path)
    expect(loadConfig(path).port).toBe(18787)

    // A fresh inode renamed over the old one, wearing the old file's mtime and
    // its exact size — the transfer-lifecycle shape. Only `ino` moves.
    const other = join(dir, 'other.json')
    writeFileSync(other, replacement)
    utimesSync(other, pinned.atime, pinned.mtime)
    expect(statSync(other).ino).not.toBe(pinned.ino)
    renameSync(other, path)

    expect(loadConfig(path).port).toBe(19999)
    expect(readsOf(path)).toBe(2)
  })

  it('refuses to cache a file whose mtime is not safely in the past', () => {
    // THE RACY-TIMESTAMP RULE, staged deterministically. A file the kernel
    // stamped this millisecond cannot be told apart from its own next same-size
    // rewrite, so the loader may only trust a signature whose mtime is old
    // enough that a later write is guaranteed to move it. An mtime AHEAD of the
    // clock fails that test on any machine at any speed, which is what makes
    // this staging of the rule independent of how fast the box runs.
    const ahead = new Date(Date.now() + 3_600_000)
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    utimesSync(path, ahead, ahead)

    expect(loadConfig(path).port).toBe(18787)
    utimesSync(path, ahead, ahead)
    expect(loadConfig(path).port).toBe(18787)

    expect(readsOf(path)).toBe(2)
  })

  it('does not serve a stale config after a same-size rewrite under one mtime', () => {
    // What the rule above buys, stated as the defect it prevents: on this box
    // six back-to-back same-size writes share ONE mtime, and the file keeps its
    // inode, so (mtimeNs, size, ino) alone reports "unchanged" for a config
    // whose every byte moved.
    const before = JSON.stringify({ mode: 'server', port: 18787 })
    const after = JSON.stringify({ mode: 'server', port: 19999 })
    expect(after).toHaveLength(before.length)

    writeFileSync(path, before)
    expect(loadConfig(path).port).toBe(18787)
    writeFileSync(path, after)

    expect(loadConfig(path).port).toBe(19999)
  })

  it('primes the cache on saveConfig, so the writer reads its own write without a read', () => {
    saveConfig({ mode: 'server', port: 18787 }, path)
    const readsAfterSave = readsOf(path)

    const loaded = loadConfig(path)

    expect(readsAfterSave).toBe(0)
    expect(readsOf(path)).toBe(0)
    expect(loaded).toEqual(expect.objectContaining({ mode: 'server', port: 18787 }))
  })

  it('notifies onConfigChanged once per saveConfig that changed the file', () => {
    const changes: { previous: PodiumConfig; next: PodiumConfig }[] = []
    const unsubscribe = onConfigChanged((change) => changes.push(change))
    try {
      saveConfig({ mode: 'server', port: 18787 }, path)
      saveConfig({ mode: 'server', port: 19999 }, path)
    } finally {
      unsubscribe()
    }

    expect(changes).toHaveLength(2)
    expect(changes[0]?.previous).toEqual({})
    expect(changes[0]?.next).toEqual(expect.objectContaining({ port: 18787 }))
    expect(changes[1]?.previous).toEqual(expect.objectContaining({ port: 18787 }))
    expect(changes[1]?.next).toEqual(expect.objectContaining({ port: 19999 }))
  })

  it('does not notify when saveConfig rewrites the same config', () => {
    saveConfig({ mode: 'server', port: 18787 }, path)
    const changes: unknown[] = []
    const unsubscribe = onConfigChanged((change) => changes.push(change))
    try {
      saveConfig({ mode: 'server', port: 18787 }, path)
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([])
  })

  it('stops notifying an unsubscribed listener', () => {
    const changes: unknown[] = []
    onConfigChanged((change) => changes.push(change))()

    saveConfig({ mode: 'server', port: 18787 }, path)

    expect(changes).toEqual([])
  })

  it('caches an absent file as absent, then sees it once it is created', () => {
    expect(loadConfig(path)).toEqual({})
    expect(loadConfig(path)).toEqual({})
    expect(readsOf(path)).toBe(0)

    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)

    expect(loadConfig(path).port).toBe(18787)
    expect(readsOf(path)).toBe(1)
  })

  it('caches a corrupt file — logging once — and picks up the repair', () => {
    writeFileSync(path, '{not json')
    backdate(path)
    const records: LogRecord[] = []
    const dispose = addSink({ name: 'config-cache-test', write: (r) => records.push(r) })
    try {
      expect(loadConfig(path)).toEqual({})
      expect(loadConfig(path)).toEqual({})
      expect(readsOf(path)).toBe(1)
      expect(records.filter((r) => r.level === 'error')).toHaveLength(1)

      writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
      backdate(path, 30)
      expect(loadConfig(path).port).toBe(18787)
    } finally {
      dispose()
    }
  })

  it('keys the cache by path, so a temp-file save does not prime the live path', () => {
    // transfer-lifecycle validates its new config by saving it to a temp path
    // beside the real one. That write says NOTHING about config.json.
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)
    expect(loadConfig(path).port).toBe(18787)

    const tempPath = join(dir, '.config-transfer.tmp')
    saveConfig({ mode: 'server', port: 19999 }, tempPath)

    expect(loadConfig(path).port).toBe(18787)
    expect(loadConfig(tempPath).port).toBe(19999)
  })

  it('sees a temp file renamed over the live path', () => {
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)
    expect(loadConfig(path).port).toBe(18787)

    const tempPath = join(dir, '.config-transfer.tmp')
    saveConfig({ mode: 'server', port: 19999 }, tempPath)
    backdate(tempPath)
    renameSync(tempPath, path)

    expect(loadConfig(path).port).toBe(19999)
  })

  it('bounds the cache, evicting the least recently used path', () => {
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)
    expect(loadConfig(path).port).toBe(18787)
    expect(readsOf(path)).toBe(1)

    // Every OTHER path is younger than `path`, so `path` is the one evicted.
    for (let i = 0; i < CONFIG_CACHE_MAX_PATHS; i++) {
      const other = join(dir, `other-${i}.json`)
      linkSync(path, other)
      loadConfig(other)
    }

    loadConfig(path)
    expect(readsOf(path)).toBe(2)
  })

  it('keeps a path that is still being read, evicting an idle one instead', () => {
    // The live config.json of a long-running server, against the stream of
    // one-shot temporary paths a transfer writes: the busy path must not be the
    // one thrown away, which is the whole difference between this and a queue.
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)
    loadConfig(path)

    const others: string[] = []
    for (let i = 0; i < CONFIG_CACHE_MAX_PATHS - 1; i++) {
      const other = join(dir, `other-${i}.json`)
      linkSync(path, other)
      others.push(other)
      loadConfig(other)
    }
    loadConfig(path) // touched again — now the most recently used
    const overflow = join(dir, 'overflow.json')
    linkSync(path, overflow)
    loadConfig(overflow) // one past the bound: something must go

    loadConfig(path)
    expect(readsOf(path)).toBe(1)
    expect(readsOf(others[0] as string)).toBe(1)
    loadConfig(others[0] as string)
    expect(readsOf(others[0] as string)).toBe(2)
  })

  it('leaves inspectConfig uncached, so a repair flow always sees the file', () => {
    writeFileSync(path, JSON.stringify({ mode: 'server', port: 18787 }))
    backdate(path)

    expect(inspectConfig(path).state).toBe('ok')
    unlinkSync(path)

    expect(inspectConfig(path).state).toBe('missing')
  })
})
