/**
 * POD-1464 — a frame the daemon cannot READ must still be ANSWERED.
 *
 * An op a daemon's build does not know fails the strict parse, and before this the throw
 * escaped handleControlMessage before any reply was sent. The server then waited out its
 * 35s timeout and the operator saw "agent relay timed out" — so a stale daemon was
 * indistinguishable from an unreachable machine, which sends whoever is debugging to the
 * network when the real answer is "update the daemon".
 *
 * Measured on vmi3407763: a bundleFetch repo op against a 0.1.2-edge.1 daemon produced a
 * bare timeout, and the cause was only visible in that host's journal.
 */
import { describe, expect, it } from 'vitest'
import { payloadRejectionReply } from './daemon'

const frame = (o: unknown): string => JSON.stringify(o)

describe('payloadRejectionReply (POD-1464)', () => {
  it('names the unsupported op and the daemon version, addressed to the waiting requestId', () => {
    const reply = payloadRejectionReply(
      frame({ type: 'repoOpRequest', requestId: 'ro-7', op: 'bundleFetch', cwd: '/r' }),
      new Error('Invalid enum value ... received bundleFetch'),
    )
    expect(reply).toBeDefined()
    expect(reply).toMatchObject({ type: 'repoOpResult', requestId: 'ro-7', ok: false })
    const output = (reply as { output: string }).output
    // The three things the operator needs: which op, which daemon, and what to DO.
    expect(output).toContain("'bundleFetch'")
    expect(output).toContain('podium')
    expect(output).toMatch(/update the daemon/i)
  })

  it('carries the version the daemon actually reports', () => {
    const prev = process.env.PODIUM_APP_VERSION
    process.env.PODIUM_APP_VERSION = '0.1.2-edge.1'
    try {
      const reply = payloadRejectionReply(
        frame({ type: 'repoOpRequest', requestId: 'ro-8', op: 'bundleCreate' }),
        new Error('x'),
      )
      expect((reply as { output: string }).output).toContain('podium 0.1.2-edge.1')
    } finally {
      if (prev === undefined) delete process.env.PODIUM_APP_VERSION
      else process.env.PODIUM_APP_VERSION = prev
    }
  })

  it('falls back to the parse error when the op field itself is unreadable', () => {
    const reply = payloadRejectionReply(
      frame({ type: 'repoOpRequest', requestId: 'ro-9', op: 42 }),
      new Error('op must be a string'),
    )
    expect((reply as { output: string }).output).toContain('op must be a string')
  })

  it('stays silent when there is nobody to answer', () => {
    // No requestId: no one is waiting on a correlated reply.
    expect(
      payloadRejectionReply(frame({ type: 'repoOpRequest', op: 'bundleFetch' }), new Error('x')),
    ).toBeUndefined()
    // Not JSON at all: there is no envelope to read a requestId out of.
    expect(payloadRejectionReply('<not json', new Error('x'))).toBeUndefined()
    // A type whose result shape we have never seen — inventing one risks emitting a
    // frame the server rejects, which is worse than the timeout it would replace.
    expect(
      payloadRejectionReply(frame({ type: 'someFutureRequest', requestId: 'r1' }), new Error('x')),
    ).toBeUndefined()
  })
})
