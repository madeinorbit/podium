import { describe, expect, it, vi } from 'vitest'
import type { LogLevel } from '../levels'
import { buildRecord } from '../record'
import { createStdoutSink } from './stdout-sink'

function record(msg: string, level: LogLevel = 'info') {
  return buildRecord({ level, ns: 'test:ns', msg, fields: { sessionId: 's1' }, context: {} })
}

describe('stdout sink', () => {
  it('writes one newline-terminated NDJSON record per line', () => {
    const stream = { write: vi.fn() }
    createStdoutSink({ stream }).write(record('hello'))
    const line = String(stream.write.mock.calls[0]?.[0])
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toMatchObject({ ns: 'test:ns', msg: 'hello', sessionId: 's1' })
  })

  it('does not mutate the record it is handed', () => {
    const stream = { write: vi.fn() }
    const given = record('shared')
    const before = structuredClone(given)
    createStdoutSink({ stream }).write(given)
    expect(given).toEqual(before)
  })

  it('follows the namespace level unless a threshold is pinned', () => {
    const stream = { write: vi.fn() }
    expect(createStdoutSink({ stream }).minLevel).toBeUndefined()
    expect(createStdoutSink({ stream, minLevel: 'warn' }).minLevel).toBe('warn')
  })

  it('swallows a broken stream — an EPIPE on stdout must not break the caller', () => {
    const stream = {
      write: vi.fn(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      }),
    }
    const sink = createStdoutSink({ stream })
    expect(() => sink.write(record('a'))).not.toThrow()
    // It stays registered and keeps trying: unlike the file sink there is
    // nothing to degrade to, so a recovered stdout resumes logging.
    expect(() => sink.write(record('b'))).not.toThrow()
    expect(stream.write).toHaveBeenCalledTimes(2)
  })
})
