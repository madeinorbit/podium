/**
 * THE BOOTSTRAP MUST NOT BE QUADRATIC IN THE CORPUS (POD-1614).
 *
 * ---------------------------------------------------------------------------
 * WHAT BROKE, STATED AS A MECHANISM
 * ---------------------------------------------------------------------------
 *
 * `scopeBootstrap` (packages/sync/src/authority/scoping.ts) asks the visibility
 * policy about EVERY ROW of the principal's world, one call per row. The
 * `conversation` arm of the policy `relay.ts` builds answered by loading the
 * WHOLE sessions table and linear-scanning it for a matching `resumeValue`:
 *
 *     const row = this.store.sessions.loadSessions().find(c => c.resumeValue === id)
 *
 * So one bootstrap cost `conversation rows x sessions`. On the live corpus
 * (2019 conversation rows, 1115 sessions) that measured 15.9 s p50 / 21.1 s max
 * in the server's own `feedBootstrap.read` counter — 18.9 s of it accounted for
 * by 2019 calls to `loadSessions()` at 9.34 ms each.
 *
 * The read is SYNCHRONOUS, so that is the event loop blocked whole. Everything
 * the operator saw came off that one wall: `/auth/status` taking 18.5 s, the
 * client's 10 s heartbeat deadline firing and force-closing the socket mid-
 * bootstrap, the reconnect starting a fresh 16-21 s bootstrap, and the app
 * taking ~60 s and two dropped connections to become usable.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ASSERTS A CALL COUNT AND NOT A DURATION
 * ---------------------------------------------------------------------------
 *
 * A wall-clock bound is the obvious test and the wrong one: this repo's lanes
 * run under load, so a duration assertion measures the host and flakes, and to
 * be reliable it would need a corpus big enough to be slow — which makes the
 * fixture itself expensive. The DEFECT is not "slow", it is "does per-row work
 * that scales with the table". A call count states exactly that and is
 * deterministic at any size.
 *
 * It can say NO: before the fix `loadSessions()` is called once per conversation
 * row, so this reads CONVERSATIONS (24) instead of 0, and the second case's two
 * corpus sizes differ instead of matching.
 */

import { asUserId, SOLE_USER_ID } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionsRepository } from './store/sessions'

const OWNER = asUserId(SOLE_USER_ID)

/** The principal a real connection is served under — `relay.ts` builds this same
 *  shape from the authenticated transport, never from a payload. */
const feedPrincipal: Principal = {
  kind: 'user',
  user: OWNER,
  device: asDeviceId('dev:probe'),
  capability: asCapabilityRef('cap:probe'),
}

/** The registry's own `Ledger` and store — private, so the reach-in is named
 *  once here rather than cast at every call site (as `automation-removal-
 *  scoping.test.ts` does for the same reason). */
const internals = (reg: SessionRegistry) =>
  reg as unknown as { ledger: Ledger; store: { sessions: SessionsRepository } }

/**
 * Append `count` conversation rows to the change log, through the Ledger — the
 * same seam `MemoryService.reconcileConversations` writes them on. Their ids are
 * the `resumeValue`s the policy will be asked to resolve.
 */
function seedConversations(reg: SessionRegistry, count: number): number {
  const specs: EntityChangeSpec[] = Array.from({ length: count }, (_, i) => ({
    entity: 'conversation',
    id: `conv-${i}`,
    op: 'upsert',
    value: { id: `conv-${i}`, machineId: 'm1', nativeId: `conv-${i}` },
  }))
  return internals(reg).ledger.capture(specs).length
}

/** How many times a bootstrap loads the WHOLE sessions table. */
function loadSessionsCallsDuringBootstrap(reg: SessionRegistry): number {
  const { ledger, store } = internals(reg)
  const original = store.sessions.loadSessions.bind(store.sessions)
  let calls = 0
  store.sessions.loadSessions = () => {
    calls++
    return original()
  }
  try {
    ledger.authority.bootstrap(feedPrincipal)
  } finally {
    store.sessions.loadSessions = original
  }
  return calls
}

describe('POD-1614 — a bootstrap does not re-read the sessions table per row', () => {
  it('never loads the whole sessions table while scoping conversation rows', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const CONVERSATIONS = 24

    // CONTROL: the rows really landed in the change log, so the bootstrap below
    // has 24 conversation rows to ask the policy about. Without this, a count of
    // 0 would pass just as well against a world that was empty — which is the
    // one way this assertion could be satisfied for the wrong reason.
    expect(seedConversations(reg, CONVERSATIONS)).toBe(CONVERSATIONS)

    // THE ASSERTION THAT WAS FAILING. Before the fix this was CONVERSATIONS: one
    // full 49-column load of every session, per conversation row.
    expect(loadSessionsCallsDuringBootstrap(reg)).toBe(0)
  })

  it('costs the same whether the corpus has 8 conversation rows or 64', () => {
    const small = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    seedConversations(small, 8)
    const large = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    seedConversations(large, 64)

    // The property, stated directly: growing the corpus 8x must not grow the
    // per-row table scans at all. Before the fix these read 8 and 64.
    expect(loadSessionsCallsDuringBootstrap(large)).toBe(loadSessionsCallsDuringBootstrap(small))
  })
})
