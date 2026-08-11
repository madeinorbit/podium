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

  it('passes an ALREADY-SERIALIZED error through instead of re-wrapping it', () => {
    // The shape a forwarded browser crash arrives in: it crossed a JSON
    // boundary, so it is a plain object and not an Error. Treated as a
    // NonError, it became `{name:'NonError', message:'{"name":"TypeError",…}'}`
    // — the stack stops being a stack, and a server relogging a client's `err`
    // double-wraps it.
    const forwarded = { name: 'TypeError', message: 'x is not a function', stack: 'at foo:1:1' }
    const serialized = serializeError(forwarded)
    expect(serialized).toEqual(forwarded)
  })

  it('recurses into the cause of an already-serialized error', () => {
    const serialized = serializeError({
      name: 'FetchError',
      message: 'upload failed',
      cause: { name: 'TypeError', message: 'body is null' },
    })
    expect(serialized.cause).toEqual({ name: 'TypeError', message: 'body is null' })
  })

  it('still calls a look-alike without a string name and message a NonError', () => {
    const serialized = serializeError({ name: 404, message: 'not found' })
    expect(serialized.name).toBe('NonError')
  })
})

describe('buildRecord', () => {
  const base = { level: 'warn' as const, ns: 'daemon:pty', msg: 'resize dropped' }

  it('will not let the process context forge ns, ts, level or msg', () => {
    // ProcessContext has an index signature, so the type system does not stop
    // this. It is worse than the same trick from a call site: the context is
    // set once at boot, so a forged `ns` would silently misattribute EVERY
    // record the process goes on to emit, and `ns` is the column every query
    // groups by.
    const record = buildRecord({
      ...base,
      fields: {},
      context: { ns: 'SPOOFED', ts: 'bogus', level: 'trace', msg: 'hijacked', role: 'daemon' },
    })
    expect(record.ns).toBe('daemon:pty')
    expect(record.msg).toBe('resize dropped')
    expect(record.level).toBe('warn')
    expect(record.ts).not.toBe('bogus')
    // role and v are the context's own to set — that is what it is for.
    expect(record.role).toBe('daemon')
  })

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
