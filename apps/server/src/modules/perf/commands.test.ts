/**
 * Report-seam attribution [POD-1230]: client switch traces land on the
 * transport principal's partition, never on a principal derived from the
 * trace body.
 */

import { asSessionId, asUserId } from '@podium/model'
import type { ClientSwitchTrace } from '@podium/protocol'
import type { FeedPrincipal } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { PERF_COMMANDS_TRPC } from './commands'
import { perfPrincipal } from './principal'
import { PerfRegistry } from './registry'

const ALICE: FeedPrincipal = { kind: 'user', userId: asUserId('user:alice') }
const BOB: FeedPrincipal = { kind: 'user', userId: asUserId('user:bob') }

function trace(switchId: string, sessionId: string): ClientSwitchTrace {
  return {
    switchId,
    startedAt: 1_000,
    // Deliberately Alice's session id even when Bob reports — payload must not
    // decide the partition.
    sessionId: asSessionId(sessionId),
    mode: 'chat',
    cold: false,
    totalMs: 42,
    timedOut: false,
    marks: [{ name: 'attach', atMs: 10 }],
  }
}

describe('perf.report attribution [POD-1230]', () => {
  it('partitions a reported trace under the transport principal, not the trace sessionId', () => {
    const reg = new PerfRegistry()
    // Bob reports a trace that names Alice's session. If attribution came from
    // payload, this would land on Alice's partition — the concrete harm D17
    // forbids.
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, feedPrincipal: BOB },
      trace('bob-forged', 'sess-alice'),
    )

    const bobKey = perfPrincipal(BOB)
    const aliceKey = perfPrincipal(ALICE)
    expect(reg.snapshotFor(bobKey)?.clientSwitches.map((t) => t.switchId)).toEqual(['bob-forged'])
    expect(reg.snapshotFor(aliceKey)).toBeUndefined()
    // Deployment-wide ring still carries it for the admin-grade snapshot.
    expect(reg.snapshot().clientSwitches.map((t) => t.switchId)).toEqual(['bob-forged'])
  })

  it('keeps two callers on separate partitions', () => {
    const reg = new PerfRegistry()
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, feedPrincipal: ALICE },
      trace('alice-switch', 'sess-a'),
    )
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, feedPrincipal: BOB },
      trace('bob-switch', 'sess-b'),
    )

    expect(
      reg.snapshotFor(perfPrincipal(ALICE))?.clientSwitches.map((t) => t.switchId),
    ).toEqual(['alice-switch'])
    expect(reg.snapshotFor(perfPrincipal(BOB))?.clientSwitches.map((t) => t.switchId)).toEqual([
      'bob-switch',
    ])
    expect(reg.snapshot().clientSwitches).toHaveLength(2)
  })

  it('refuses to report without a transport principal rather than dumping into DEPLOYMENT', () => {
    const reg = new PerfRegistry()
    expect(() =>
      PERF_COMMANDS_TRPC.report.handler({ perf: reg }, trace('orphan', 'sess-x')),
    ).toThrow(/authenticated feed principal required/)
    expect(reg.snapshot().clientSwitches).toHaveLength(0)
  })
})
