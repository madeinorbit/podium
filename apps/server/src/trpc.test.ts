/**
 * THE tRPC TIMING MIDDLEWARE FEEDS THE `rpc` COST BUCKET (§6.1).
 *
 * `rpc` is the one bucket recorded as WALL time across a handler's awaits rather
 * than own-CPU — the synchronous slices between them are not separable at this
 * seam — which is why the minute record flags it inclusive. What is worth pinning
 * is that the middleware still reaches the bucket at all: it is attached to the
 * base procedure, so a router that was built from a bare `core.procedure`
 * instead would lose both the perf record and the attribution with no test
 * noticing and nothing in the logs to say so.
 */

import { addLoopAccounting, clearLoopAccounting } from '@podium/runtime/loop-accounting'
import { afterEach, describe, expect, it } from 'vitest'
import { t } from './trpc'

describe('rpc attribution', () => {
  afterEach(() => clearLoopAccounting())

  function capture(): [string, number][] {
    const calls: [string, number][] = []
    addLoopAccounting({ attribute: (bucket, wallMs) => calls.push([bucket, wallMs]) })
    return calls
  }

  it('bills one procedure call to the rpc bucket', async () => {
    const calls = capture()
    const router = t.router({ ping: t.procedure.query(() => 'pong') })
    expect(await router.createCaller({} as never).ping()).toBe('pong')
    expect(calls.map(([bucket]) => bucket)).toEqual(['rpc'])
    expect(calls[0]?.[1]).toBeGreaterThanOrEqual(0)
  })

  it('bills a FAILED call too — a procedure that throws still cost the loop', async () => {
    const calls = capture()
    const router = t.router({
      boom: t.procedure.query(() => {
        throw new Error('nope')
      }),
    })
    await expect(router.createCaller({} as never).boom()).rejects.toThrow('nope')
    expect(calls.map(([bucket]) => bucket)).toEqual(['rpc'])
  })
})
