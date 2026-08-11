import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLevel } from '../levels'
import { buildRecord } from '../record'
import { createFileSink, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from './file-sink'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-file-sink-'))
  path = join(dir, 'server.ndjson')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(msg: string, level: LogLevel = 'info') {
  return buildRecord({ level, ns: 'test:ns', msg, fields: {}, context: {} })
}

/** The messages of every record in a written file, in file order. */
function messages(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l).msg as string)
}

/** Every record still on disk, oldest archive first, ending with the live file. */
function everything(): string[] {
  const archives: string[] = []
  for (let i = 9; i >= 1; i--) {
    if (existsSync(`${path}.${i}`)) archives.push(`${path}.${i}`)
  }
  return [...archives, path].filter(existsSync).flatMap(messages)
}

describe('file sink', () => {
  it('writes one NDJSON record per line', () => {
    const sink = createFileSink({ path })
    sink.write(record('first'))
    sink.write(record('second'))
    sink.close()
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ns: 'test:ns', msg: 'first' })
  })

  it('does not mutate the record it is handed', () => {
    // Records are shared BY REFERENCE with every other sink and with the
    // ring-buffer snapshot a crash payload ships, so in-place tidying here
    // would rewrite another sink's history.
    const sink = createFileSink({ path })
    const given = record('shared')
    const before = structuredClone(given)
    sink.write(given)
    sink.close()
    expect(given).toEqual(before)
  })

  it('creates the log directory rather than failing on a fresh install', () => {
    const nested = join(dir, 'a', 'b', 'server.ndjson')
    const sink = createFileSink({ path: nested })
    sink.write(record('hello'))
    sink.close()
    expect(existsSync(nested)).toBe(true)
  })

  it('appends to a previous run instead of truncating it', () => {
    writeFileSync(path, `${JSON.stringify({ msg: 'from a previous run' })}\n`)
    const sink = createFileSink({ path })
    sink.write(record('from this run'))
    sink.close()
    expect(messages(path)).toEqual(['from a previous run', 'from this run'])
  })

  it('follows the namespace level unless a threshold is pinned', () => {
    expect(createFileSink({ path }).minLevel).toBeUndefined()
    expect(createFileSink({ path, minLevel: 'warn' }).minLevel).toBe('warn')
  })

  it('defaults to the spec budget: 10 MiB across 5 files', () => {
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(DEFAULT_MAX_FILES).toBe(5)
  })

  describe('rotation', () => {
    it('rotates when the next record would cross maxBytes', () => {
      // Each record is well under 200 bytes, so this rotates every few writes.
      const sink = createFileSink({ path, maxBytes: 200 })
      sink.write(record('a'))
      expect(existsSync(`${path}.1`)).toBe(false)
      const sizeOfOne = statSync(path).size
      // Write until the accumulated size must have crossed the threshold.
      for (const msg of ['b', 'c', 'd', 'e']) sink.write(record(msg))
      sink.close()
      expect(sizeOfOne).toBeLessThan(200)
      expect(existsSync(`${path}.1`)).toBe(true)
      // Nothing was lost across the boundary. Which file a given record landed
      // in depends on its byte length, so the claim is about the SET of files,
      // read oldest-archive first, not about a particular split.
      expect(everything()).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('never leaves the live file over the budget', () => {
      const sink = createFileSink({ path, maxBytes: 400 })
      for (let i = 0; i < 60; i++) sink.write(record(`m${i}`))
      sink.close()
      expect(statSync(path).size).toBeLessThanOrEqual(400)
    })

    it('keeps maxFiles files in total and drops the oldest', () => {
      const sink = createFileSink({ path, maxBytes: 150, maxFiles: 3 })
      for (let i = 0; i < 40; i++) sink.write(record(`m${i}`))
      sink.close()
      expect(existsSync(path)).toBe(true)
      expect(existsSync(`${path}.1`)).toBe(true)
      expect(existsSync(`${path}.2`)).toBe(true)
      // maxFiles counts the LIVE file, so `.3` would be a fourth.
      expect(existsSync(`${path}.3`)).toBe(false)
    })

    it('ages archives oldest-last: .1 is always the most recent', () => {
      const sink = createFileSink({ path, maxBytes: 150, maxFiles: 3 })
      for (let i = 0; i < 40; i++) sink.write(record(`m${i}`))
      sink.close()
      const olderThan = (a: string, b: string): boolean =>
        Number((messages(a).at(-1) as string).slice(1)) <
        Number((messages(b).at(0) as string).slice(1))
      expect(olderThan(`${path}.2`, `${path}.1`)).toBe(true)
      expect(olderThan(`${path}.1`, path)).toBe(true)
    })

    it('starts the live file over when no archives are kept', () => {
      const sink = createFileSink({ path, maxBytes: 150, maxFiles: 1 })
      for (let i = 0; i < 20; i++) sink.write(record(`m${i}`))
      sink.close()
      expect(existsSync(`${path}.1`)).toBe(false)
      expect(statSync(path).size).toBeLessThanOrEqual(150)
    })

    it('writes a single oversized record rather than rotating forever', () => {
      const sink = createFileSink({ path, maxBytes: 10 })
      sink.write(record('a record far longer than ten bytes'))
      sink.close()
      expect(messages(path)).toEqual(['a record far longer than ten bytes'])
    })

    it('accounts for what a restart inherited, so a restart cannot double the budget', () => {
      const sink = createFileSink({ path, maxBytes: 200 })
      for (let i = 0; i < 3; i++) sink.write(record(`m${i}`))
      sink.close()
      const carried = statSync(path).size

      const restarted = createFileSink({ path, maxBytes: 200 })
      restarted.write(record('after restart'))
      expect(restarted.bytes).toBeGreaterThan(carried)
      restarted.close()
    })

    it('refuses a nonsensical budget rather than silently keeping nothing', () => {
      expect(() => createFileSink({ path, maxFiles: 0 })).toThrow(/maxFiles/)
      expect(() => createFileSink({ path, maxBytes: 0 })).toThrow(/maxBytes/)
    })
  })

  describe('degradation', () => {
    /** A path whose parent is a FILE, so every open of it fails like ENOSPC. */
    function unwritablePath(): string {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'not a directory')
      return join(blocker, 'server.ndjson')
    }

    it('never throws out of write() — logging cannot break the caller', () => {
      const target = { error: vi.fn() }
      const sink = createFileSink({ path: unwritablePath(), console: target })
      expect(() => sink.write(record('boom'))).not.toThrow()
    })

    it('warns exactly once and then writes records to the console instead', () => {
      const target = { error: vi.fn() }
      const sink = createFileSink({ path: unwritablePath(), console: target })
      sink.write(record('one'))
      sink.write(record('two'))
      sink.write(record('three'))

      const warnings = target.error.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('degraded to the console'))
      expect(warnings).toHaveLength(1)
      expect(sink.degraded).toBe(true)

      // Every record still reached somewhere, as NDJSON.
      const written = target.error.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('{'))
        .map((m) => JSON.parse(m).msg as string)
      expect(written).toEqual(['one', 'two', 'three'])
    })

    it('does not keep probing the filesystem once degraded', () => {
      const target = { error: vi.fn() }
      const blocked = unwritablePath()
      const sink = createFileSink({ path: blocked, console: target })
      sink.write(record('one'))
      // Clear the obstruction. A sink that retried would start writing a file
      // again; this one stays degraded for the life of the process.
      rmSync(join(dir, 'blocker'), { force: true })
      sink.write(record('two'))
      expect(existsSync(blocked)).toBe(false)
    })
  })

  describe('drain seam', () => {
    it('resolves flush() — every accepted record is already on the fd', async () => {
      const sink = createFileSink({ path })
      sink.write(record('durable before flush'))
      expect(messages(path)).toEqual(['durable before flush'])
      await expect(sink.flush()).resolves.toBeUndefined()
    })

    it('sends records to the console after close rather than losing them', () => {
      const target = { error: vi.fn() }
      const sink = createFileSink({ path, console: target })
      sink.write(record('before'))
      sink.close()
      sink.write(record('after'))
      expect(messages(path)).toEqual(['before'])
      expect(String(target.error.mock.calls[0]?.[0])).toContain('"msg":"after"')
    })

    it('tolerates a double close', () => {
      const sink = createFileSink({ path })
      sink.write(record('x'))
      sink.close()
      expect(() => sink.close()).not.toThrow()
    })
  })
})
