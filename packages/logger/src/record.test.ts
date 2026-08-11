import { describe, expect, it } from 'vitest'
import { buildRecord, RESERVED_KEYS, serializeError, toNdjson } from './record'

describe('serializeError', () => {
  it('keeps name, message and stack of a real Error', () => {
    const err = new TypeError('bad shape')
    const serialized = serializeError(err)
    expect(serialized.name).toBe('TypeError')
    expect(serialized.message).toBe('bad shape')
    expect(serialized.stack).toContain('bad shape')
  })

  it('serializes a nested cause', () => {
    const serialized = serializeError(new Error('outer', { cause: new Error('inner') }))
    expect(serialized.cause?.message).toBe('inner')
  })

  it('stops recursing on a self-referential cause', () => {
    const err = new Error('loop') as Error & { cause?: unknown }
    err.cause = err
    expect(() => serializeError(err)).not.toThrow()
  })

  it('describes a thrown non-Error without losing its value', () => {
    const serialized = serializeError('just a string')
    expect(serialized.name).toBe('NonError')
    expect(serialized.message).toBe('just a string')
    expect(serialized.stack).toBeUndefined()
  })
})

describe('buildRecord', () => {
  const base = { level: 'warn' as const, ns: 'daemon:pty', msg: 'resize dropped' }

  it('stamps an ISO-8601 timestamp with millisecond precision', () => {
    const record = buildRecord({ ...base, fields: {}, context: {} })
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('carries free-form fields alongside the process context', () => {
    const record = buildRecord({
      ...base,
      fields: { sessionId: 's1', attempt: 2 },
      context: { role: 'daemon', v: '0.1.3' },
    })
    expect(record).toMatchObject({
      level: 'warn',
      ns: 'daemon:pty',
      msg: 'resize dropped',
      sessionId: 's1',
      attempt: 2,
      role: 'daemon',
      v: '0.1.3',
    })
  })

  it('serializes an Error passed as the err field', () => {
    const record = buildRecord({ ...base, fields: { err: new Error('boom') }, context: {} })
    expect(record.err).toEqual(expect.objectContaining({ name: 'Error', message: 'boom' }))
  })

  it('refuses to let a caller field overwrite a reserved key', () => {
    const record = buildRecord({
      ...base,
      fields: { ns: 'spoofed', level: 'error', ts: 'nope', msg: 'nope' },
      context: {},
    })
    expect(record.ns).toBe('daemon:pty')
    expect(record.level).toBe('warn')
    expect(record.msg).toBe('resize dropped')
    expect(record.ts).not.toBe('nope')
  })

  it('names the reserved keys the spec reserves', () => {
    expect([...RESERVED_KEYS].sort()).toEqual(['err', 'level', 'msg', 'ns', 'role', 'ts', 'v'])
  })
})

describe('toNdjson', () => {
  it('emits one newline-terminated JSON object leading with ts, level, ns, msg', () => {
    const line = toNdjson(
      buildRecord({
        level: 'warn',
        ns: 'daemon:pty',
        msg: 'resize dropped',
        fields: { sessionId: 's1' },
        context: { role: 'daemon', v: '0.1.3' },
      }),
    )
    expect(line.endsWith('\n')).toBe(true)
    expect(Object.keys(JSON.parse(line)).slice(0, 4)).toEqual(['ts', 'level', 'ns', 'msg'])
  })

  it('survives a circular field rather than throwing at the call site', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const line = toNdjson(
      buildRecord({ level: 'info', ns: 'x', msg: 'm', fields: { circular }, context: {} }),
    )
    expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(line).msg).toBe('m')
  })
})
