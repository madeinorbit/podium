/**
 * A RUNTIME EVENT ASKS FOR THE FIRST ADMIN AND ITS SETTINGS ONCE [POD-6218,
 * server-data rule 8].
 *
 * Every session projection without an explicit reader acts as the instance's
 * earliest admin (`SessionView.defaultPrincipal`), and the runtime-event paths
 * read that member's settings (relay `onSessionActivity`, the auto-continue
 * check in `session-wiring.ts`). On the server-data bench (POD-6140 result §4)
 * one runtime event asked for the earliest admin about four times, two
 * statements each (the id, then the account by id), and read `meta` and
 * `user_preferences` for the settings twice: about 9.4k statements/min.
 *
 * Now `UsersRepository.earliestAdmin` and `SettingsRepository.getSettingsFor`
 * answer through per-operation loaders: one statement for the earliest admin's
 * row, and one read of each settings table, per operation.
 */
import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  expectConstantStatements,
  type PinnedCounts,
  quietShipping,
  type StatementPin,
  type StatementTally,
} from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
}

/** `size` bound codex sessions on the app-server contract driver. */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {})
  await quietShipping(reg)
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd: `/w${i}` })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex',
      cwd: `/w${i}`,
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
      driverId: 'codex-app-server',
    } as never)
    ids.push(sessionId)
  }
  await settle(reg)
  return { store, reg, ids }
}

/** Let the frame's unawaited bus listeners and the coalesced broadcast finish. */
async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

const reads = (tally: StatementTally, table: RegExp): number =>
  [...tally.byQuery].reduce((n, [key, count]) => (table.test(key) ? n + count : n), 0)

const USERS = /^select\b.*\bfrom "users"/i
const META = /^select\b.*\bfrom "meta"/i
const PREFERENCES = /^select\b.*\bfrom "user_preferences"/i

const expectReads = (counts: PinnedCounts, table: RegExp, expected: number): void => {
  expect(reads(counts.small, table), `${table} at the small size`).toBe(expected)
  expect(reads(counts.large, table), `${table} at the large size`).toBe(expected)
}

const at = '2026-10-17T12:00:20.000Z'

/** The bench's runtime event (`scripts/server-data-bench/drive.ts`): a state snapshot. */
const stateSnapshot = (sessionId: SessionId, seq: number) => ({
  type: 'runtimeEvent',
  sessionId,
  deliveryId: `state-${seq}`,
  event: {
    t: 'state',
    change: { kind: 'state_snapshot', state: { phase: 'working', since: at, nativeSubagentCount: 0 } },
    at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq } },
    observerGeneration: 1,
    turnEpoch: 0,
  },
})

const pin: StatementPin<Fixture> = {
  name: 'runtimeEvent state snapshot',
  setup: fixture,
  target: (f) => f.store,
  run: async (f) => {
    await f.reg.gateway.routeDaemonFrame(f.reg.sessionStore.hostMachineId, stateSnapshot(f.ids[0]!, 30) as never)
    await settle(f.reg)
  },
  check: (_result, f) => {
    expect(f.reg.modules.sessions.sessions.get(f.ids[0]!)?.agentState?.phase).toBe('working')
  },
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
}

describe('the default principal per runtime event: pinned at 5 and 200 sessions', () => {
  it('reads the earliest admin once and its settings once', async () => {
    const counts = await expectConstantStatements(pin, RUNTIME_EVENT)
    expectReads(counts, USERS, 1)
    expectReads(counts, META, 1)
    expectReads(counts, PREFERENCES, 1)
  })
})

// Measured on the polaris VM. Before POD-6218 this frame ran 36 (on e617c446a5:
// `users` 8, `meta` 2, `user_preferences` 2); POD-6216's board drain then
// removed three (11ab04ade0 among them), so 33 on the parent of this change.
const RUNTIME_EVENT = 24
