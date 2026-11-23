/**
 * Report-seam attribution [POD-1230]: client switch traces land on the
 * transport principal's partition, never on a principal derived from the
 * trace body.
 */

import { asSessionId, asUserId, asWorkspaceId } from '@podium/model'
import type { ClientSwitchTrace } from '@podium/protocol'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { PERF_COMMANDS_TRPC } from './commands'
import { perfPrincipal } from './principal'
import { PerfRegistry } from './registry'

const ALICE: Principal = {
  kind: 'user',
  user: asUserId('user:alice'),
  device: asDeviceId('dev'),
  capability: asCapabilityRef('cap'),
}
const BOB: Principal = {
  kind: 'user',
  user: asUserId('user:bob'),
  device: asDeviceId('dev'),
  capability: asCapabilityRef('cap'),
}
const WS = asWorkspaceId('ws_a')
const OTHER_WS = asWorkspaceId('ws_b')

/** The reads a report handler never makes, so the bundle can be built at all.
 *  `loopMinutes` is REQUIRED on `PerfState` on purpose — see the field's comment
 *  — so a caller that only exercises `report` still has to state one. */
const noLoopMinutes = () => ({})

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
      { perf: reg, workspaceId: WS, feedPrincipal: BOB, loopMinutes: noLoopMinutes },
      trace('bob-forged', 'sess-alice'),
    )

    const bobKey = perfPrincipal(WS, BOB)
    const aliceKey = perfPrincipal(WS, ALICE)
    expect(reg.snapshotFor(bobKey)?.clientSwitches.map((t) => t.switchId)).toEqual(['bob-forged'])
    expect(reg.snapshotFor(aliceKey)).toBeUndefined()
    // Deployment-wide ring still carries it for the admin-grade snapshot.
    expect(reg.snapshot().clientSwitches.map((t) => t.switchId)).toEqual(['bob-forged'])
  })

  it('keeps two callers on separate partitions', () => {
    const reg = new PerfRegistry()
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, workspaceId: WS, feedPrincipal: ALICE, loopMinutes: noLoopMinutes },
      trace('alice-switch', 'sess-a'),
    )
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, workspaceId: WS, feedPrincipal: BOB, loopMinutes: noLoopMinutes },
      trace('bob-switch', 'sess-b'),
    )

    expect(
      reg.snapshotFor(perfPrincipal(WS, ALICE))?.clientSwitches.map((t) => t.switchId),
    ).toEqual(['alice-switch'])
    expect(reg.snapshotFor(perfPrincipal(WS, BOB))?.clientSwitches.map((t) => t.switchId)).toEqual([
      'bob-switch',
    ])
    expect(reg.snapshot().clientSwitches).toHaveLength(2)
  })

  it('keeps one member id in two workspaces on separate partitions (POD-6959 design 2.8)', () => {
    const reg = new PerfRegistry()
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, workspaceId: WS, feedPrincipal: ALICE, loopMinutes: noLoopMinutes },
      trace('alice-in-a', 'sess-a'),
    )
    PERF_COMMANDS_TRPC.report.handler(
      { perf: reg, workspaceId: OTHER_WS, feedPrincipal: ALICE, loopMinutes: noLoopMinutes },
      trace('alice-in-b', 'sess-a'),
    )

    const inA = perfPrincipal(WS, ALICE)
    const inB = perfPrincipal(OTHER_WS, ALICE)
    expect(inA.digest).not.toBe(inB.digest)
    expect(reg.snapshotFor(inA)?.clientSwitches.map((t) => t.switchId)).toEqual(['alice-in-a'])
    expect(reg.snapshotFor(inB)?.clientSwitches.map((t) => t.switchId)).toEqual(['alice-in-b'])
    // The deployment-wide snapshot lists them as two principals, not one.
    expect(Object.keys(reg.snapshot().byPrincipal).sort()).toEqual([inA.digest, inB.digest].sort())
  })

  it('refuses to report without a transport principal rather than dumping into DEPLOYMENT', () => {
    const reg = new PerfRegistry()
    expect(() =>
      PERF_COMMANDS_TRPC.report.handler(
        { perf: reg, workspaceId: WS, loopMinutes: noLoopMinutes },
        trace('orphan', 'sess-x'),
      ),
    ).toThrow(/authenticated feed principal required/)
    expect(reg.snapshot().clientSwitches).toHaveLength(0)
  })
})
