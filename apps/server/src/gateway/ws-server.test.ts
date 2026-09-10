/**
 * THE I/O-COMPLETION SEAM FEEDS ITS COST BUCKET (§6.1).
 *
 * The label-to-bucket routing is pinned in `@podium/runtime`'s task-attribution
 * tests. What those cannot see is whether THIS seam still emits a label that
 * routes: `ws.message.${kind}` is built here, and renaming it — or dropping the
 * `measureTask` wrapper in a refactor of the native handler — would leave the
 * `ws.client` and `ws.daemon` buckets silently empty while every test still
 * passed and coverage quietly fell. So this drives one real inbound frame
 * through the handler the Bun server is actually given, and reads the bucket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A heartbeat that never fires: this test is about one frame, not liveness. */
const SILENT_TIMERS = { setInterval: () => 0, clearInterval: () => {} }

/**
 * The native handler under a STATED level.
 *
 * `measureTask` reads the level at IMPORT and a test run resolves `off`
 * (POD-3827), so the level is stated and both modules re-imported — the gateway
 * for the seam, `loop-accounting` because `vi.resetModules` gives the fresh graph
 * its own bucket registry and a spy put into the old one is never called.
 */
async function handlerWithBuckets(): Promise<{
  message: (native: unknown, frame: string) => void
  buckets: string[]
}> {
  process.env.PODIUM_LOOP_PROFILE = 'attribution'
  vi.resetModules()
  const accounting = await import('@podium/runtime/loop-accounting')
  const { attachWebSockets } = await import('./ws-server')
  const buckets: string[] = []
  accounting.addLoopAccounting({ attribute: (bucket) => buckets.push(bucket) })
  const handle = attachWebSockets({} as never, {}, { timers: SILENT_TIMERS })
  return {
    message: (native, frame) =>
      (handle.websocket.message as (n: unknown, f: string) => void)(native, frame),
    buckets,
  }
}

/** The shape the native handler reads off a socket: its plane and its emitter. */
const socketOf = (kind: string | undefined, seen: string[]) => ({
  data: { kind, socket: { emit: (_event: string, frame: string) => seen.push(frame) } },
})

describe('native message attribution', () => {
  let prior: string | undefined
  beforeEach(() => {
    prior = process.env.PODIUM_LOOP_PROFILE
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.PODIUM_LOOP_PROFILE
    else process.env.PODIUM_LOOP_PROFILE = prior
    vi.resetModules()
  })

  it('bills a client frame to ws.client and still delivers it', async () => {
    const { message, buckets } = await handlerWithBuckets()
    const delivered: string[] = []
    message(socketOf('client', delivered), '{"type":"hello"}')
    expect(buckets).toEqual(['ws.client'])
    expect(delivered).toEqual(['{"type":"hello"}'])
  })

  it('bills a daemon frame and a machine frame to the one ws.daemon bucket', async () => {
    const { message, buckets } = await handlerWithBuckets()
    const delivered: string[] = []
    message(socketOf('daemon', delivered), 'daemon-frame')
    message(socketOf('machine', delivered), 'machine-frame')
    // One bucket for both planes on purpose: they are the same traffic shape to
    // the loop, and splitting them would answer a question nobody asked while
    // making the records of two deployments incomparable.
    expect(buckets).toEqual(['ws.daemon', 'ws.daemon'])
    expect(delivered).toEqual(['daemon-frame', 'machine-frame'])
  })

  it('bills a frame whose plane it cannot read to NO bucket', async () => {
    const { message, buckets } = await handlerWithBuckets()
    const delivered: string[] = []
    message(socketOf(undefined, delivered), 'mystery')
    // `ws.message.unknown` is recorded under its own name but billed nowhere: a
    // default bucket here would report the FALLBACK as measured plane traffic.
    expect(buckets).toEqual([])
    expect(delivered).toEqual(['mystery'])
  })
})
