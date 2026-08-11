import { describe, expect, it } from 'vitest'
import type { LogLevel } from '../levels'
import type { Fields } from '../record'
import { buildRecord } from '../record'
import { createConsoleSink } from './console'

function record(level: LogLevel, msg = 'resize dropped', fields: Fields = {}) {
  return buildRecord({
    level,
    ns: 'daemon:pty',
    msg,
    fields,
    context: { role: 'daemon', v: '0.1.3' },
  })
}

function fakeConsole() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const push =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }
  return {
    calls,
    console: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') },
  }
}

describe('console sink', () => {
  it('follows the configured namespace level by default', () => {
    expect(createConsoleSink().minLevel).toBeUndefined()
  })

  it('honours an explicitly pinned threshold', () => {
    expect(createConsoleSink({ minLevel: 'warn' }).minLevel).toBe('warn')
  })

  it('writes one parseable NDJSON object when not pretty', () => {
    const fake = fakeConsole()
    createConsoleSink({ pretty: false, console: fake.console }).write(record('warn'))
    const line = String(fake.calls[0]?.args[0])
    expect(line.endsWith('\n')).toBe(false)
    expect(JSON.parse(line)).toMatchObject({ level: 'warn', ns: 'daemon:pty', role: 'daemon' })
  })

  it('renders level, namespace, message and fields when pretty', () => {
    const fake = fakeConsole()
    createConsoleSink({ pretty: true, console: fake.console }).write(
      record('warn', 'resize dropped', { sessionId: 's1', attempt: 2 }),
    )
    const line = String(fake.calls[0]?.args[0])
    expect(line).toContain('WARN')
    expect(line).toContain('daemon:pty')
    expect(line).toContain('resize dropped')
    expect(line).toContain('sessionId=s1')
    expect(line).toContain('attempt=2')
  })

  it('shows the stack of a serialized error when pretty', () => {
    const fake = fakeConsole()
    createConsoleSink({ pretty: true, console: fake.console }).write(
      record('error', 'write failed', { err: new Error('disk full') }),
    )
    expect(fake.calls[0]?.args.join(' ')).toContain('disk full')
  })

  it('routes each level to the matching console method', () => {
    const fake = fakeConsole()
    const sink = createConsoleSink({ pretty: true, console: fake.console })
    for (const level of ['error', 'warn', 'info', 'debug', 'trace'] as const) {
      sink.write(record(level))
    }
    expect(fake.calls.map((c) => c.method)).toEqual(['error', 'warn', 'info', 'debug', 'debug'])
  })
})
