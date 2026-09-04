import { describe, expect, test } from 'vitest'
import { originRefusalReporter } from './origin-refusal'

describe('originRefusalReporter', () => {
  test('names the origin, the host and the reason', () => {
    const lines: Array<[string, Record<string, unknown>]> = []
    const report = originRefusalReporter((message, fields) => lines.push([message, fields]))

    report({ origin: 'https://evil.example', host: 'api.meetpodium.com', reason: 'not-allowed' })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.[0]).toContain('refused')
    expect(lines[0]?.[1]).toEqual({
      origin: 'https://evil.example',
      host: 'api.meetpodium.com',
      reason: 'not-allowed',
    })
  })

  test('says each distinct refusal once, however often it happens', () => {
    // A page that is refused retries; a hostile one can retry deliberately. The
    // log is a diagnosis, not a counter, and an unbounded one is an amplifier.
    const lines: unknown[] = []
    const report = originRefusalReporter((_message, fields) => lines.push(fields))

    for (let i = 0; i < 50; i++) {
      report({ origin: 'https://evil.example', host: 'api.meetpodium.com', reason: 'not-allowed' })
    }

    expect(lines).toHaveLength(1)
  })

  test('a different origin, host or reason is a different thing to say', () => {
    const lines: unknown[] = []
    const report = originRefusalReporter((_message, fields) => lines.push(fields))

    report({ origin: 'https://evil.example', host: 'api.meetpodium.com', reason: 'not-allowed' })
    report({ origin: 'https://other.example', host: 'api.meetpodium.com', reason: 'not-allowed' })
    report({ origin: 'https://evil.example', host: 'other.meetpodium.com', reason: 'not-allowed' })
    report({ origin: 'https://evil.example', host: 'api.meetpodium.com', reason: 'parse' })

    expect(lines).toHaveLength(4)
  })

  test('an absent origin or host is still reported, and still only once', () => {
    const lines: Array<Record<string, unknown>> = []
    const report = originRefusalReporter((_message, fields) => lines.push(fields))

    report({ reason: 'parse' })
    report({ reason: 'parse' })

    expect(lines).toEqual([{ reason: 'parse' }])
  })
})
