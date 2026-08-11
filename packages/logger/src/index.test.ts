import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addSink,
  configureLevelsFromEnv,
  createLogger,
  createRingBufferSink,
  resetLogging,
  setProcessContext,
  toNdjson,
} from './index'

beforeEach(() => {
  resetLogging()
  configureLevelsFromEnv({})
})
afterEach(() => {
  resetLogging()
})

describe('@podium/logger', () => {
  it('produces the record shape the spec documents, end to end', () => {
    const ring = createRingBufferSink({ capacity: 10 })
    addSink(ring)
    setProcessContext({ role: 'daemon', v: '0.1.3' })

    createLogger('daemon:pty').child({ sessionId: 's-42' }).warn('resize dropped')

    const line = toNdjson(ring.snapshot()[0] as never)
    expect(JSON.parse(line)).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      level: 'warn',
      ns: 'daemon:pty',
      msg: 'resize dropped',
      sessionId: 's-42',
      role: 'daemon',
      v: '0.1.3',
    })
  })
})
