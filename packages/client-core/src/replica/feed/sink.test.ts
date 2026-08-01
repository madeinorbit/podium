import { describe, expect, it } from 'vitest'
import { FeedSink } from './sink'

describe('FeedSink lifecycle', () => {
  it('keeps an in-flight bootstrap walk alive across its requested socket replacement', () => {
    let requested = true
    let disconnects = 0
    const sink = new FeedSink({
      replica: {
        connect: () => {},
        disconnect: () => {
          disconnects += 1
        },
        receive: () => {},
      } as never,
      bootstraps: {
        reset: () => {
          const result = requested
          requested = false
          return result
        },
      } as never,
    })

    sink.disconnected()
    expect(disconnects).toBe(0)

    sink.disconnected()
    expect(disconnects).toBe(1)
  })
})
