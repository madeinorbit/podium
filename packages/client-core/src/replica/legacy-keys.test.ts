/**
 * ADR 6 D6's key inventory, MEASURED against the writer (POD-307).
 *
 * POD-374 declined to build the legacy importer and gave the reason: "an
 * importer built against a guessed key set is mechanism-present /
 * coverage-absent". This file is what makes the inventory in
 * `@podium/sync/adapters/legacy-replica` not a guess. It drives the REAL legacy
 * writer — `createReplica`, the TanStack-backed replica that is still the
 * shipping web and mobile path — over an observable storage seam, and asserts
 * that the keys it actually produces are exactly the ones the importer looks for.
 *
 * WHY THE PROOF IS HERE AND THE LIST IS THERE. `packages/sync` is L2 and may not
 * import `packages/client-core` (L3), so the inventory cannot be derived from the
 * writer at runtime. Splitting it this way makes the drift a TEST FAILURE rather
 * than a silent divergence: rename a collection key in replica.ts and this goes
 * red, naming the key the importer would have missed.
 *
 * THE TRAP THIS IS WRITTEN AGAINST. An inventory test that only asserts
 * `writtenKeys ⊆ inventory` passes perfectly against a writer that wrote NOTHING
 * — the "empty router satisfies every absence claim" shape. So the assertions run
 * in both directions, and the exercise below is checked to have actually produced
 * writes before either direction is believed.
 */

import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/model'
import {
  LEGACY_CURSOR_KEY,
  LEGACY_ENTITY_KEYS,
  LEGACY_OUTBOX_KEY,
  LEGACY_REPLICA_PREFIX,
  LEGACY_REPLICA_STATE_KEYS,
  LEGACY_UI_STATE_KEY,
  isLegacyReplicaStateKey,
  readLegacyReplica,
} from '@podium/sync/adapters/legacy-replica'
import { describe, expect, it } from 'vitest'
import { createReplica } from './replica'

/** `memoryStorage()` hides its map; this one is the same seam with the key set
 *  observable, which is the whole measurement. */
function observableStorage(): { api: ReturnType<typeof make>; keys: () => string[] } {
  const data = new Map<string, string>()
  function make() {
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    }
  }
  return { api: make(), keys: () => [...data.keys()] }
}

const session = (id: string): SessionMeta =>
  ({ sessionId: id, title: id, agentKind: 'claude-code' }) as unknown as SessionMeta
const issue = (id: string): IssueWire => ({ id, title: id }) as unknown as IssueWire
/** Any collection row: the inventory measures KEYS, so the payload only has to
 *  be non-empty and carry an id. */
const row = (id: string): never => ({ id, sessionId: id, title: id }) as unknown as never

/** Exercise every durable surface the old replica has: entity collections, the
 *  transcript window, the cursor, the outbox and ui-state. */
async function exerciseLegacyReplica(): Promise<{ keys: string[] }> {
  const storage = observableStorage()
  const replica = createReplica({ storage: storage.api, enumerateKeys: () => storage.keys() })
  replica.applySnapshot('sessions', [session('sess_1')])
  replica.applySnapshot('issues', [issue('iss_1')])
  // Every kind gets a ROW. An empty snapshot writes no key at all, so a version
  // of this exercise that passed `[]` certified an inventory against four
  // collections that were never persisted — found by the assertion below, which
  // is why it names each key instead of checking a count.
  replica.applySnapshot('conversations', [row('conv_1')])
  replica.applySnapshot('automations', [row('auto_1')])
  replica.applySnapshot('automationRuns', [row('run_1')])
  replica.putTranscriptWindow('conv_1', [
    { id: 'i1', role: 'user', text: 'hi' } as unknown as TranscriptItem,
  ])
  replica.setCursor(42)
  replica.outboxStorage().save([
    { mutationId: 'mut_1', kind: 'sessions.rename', input: { title: 'x' }, queuedAt: 1 },
  ])
  replica.uiState().set('podium.view', 'home')
  // The cursor write is FENCED behind the entity writes issued before it — the
  // cursor-after-data invariant, implemented as a promise chain. So it lands a
  // few microtasks later, and an exercise that read the key set synchronously
  // measured an inventory with no cursor in it. Drained rather than slept on: a
  // fixed timeout before an assertion is a flake in this lane.
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  return { keys: storage.keys() }
}

describe('ADR 6 D6 — the legacy key inventory matches the writer', () => {
  it('the exercise actually WRITES — the control every other case rests on', async () => {
    // Without this, a writer that silently no-ops would satisfy the subset
    // assertion below perfectly and the inventory would be certified against
    // nothing.
    const { keys } = await exerciseLegacyReplica()
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.some((k) => k.startsWith(LEGACY_REPLICA_PREFIX))).toBe(true)
  })

  it('every REPLICA-STATE key the writer produces is in the inventory', async () => {
    const { keys } = await exerciseLegacyReplica()
    const underPrefix = keys.filter((k) => k.startsWith(`${LEGACY_REPLICA_PREFIX}.`))
    const unknown = underPrefix.filter(
      (k) => !isLegacyReplicaStateKey(k) && k !== LEGACY_UI_STATE_KEY,
    )
    expect(unknown, 'keys the importer would silently leave behind').toEqual([])
  })

  it('the writer produces the entity, cursor and outbox keys the importer expects', async () => {
    // The other direction. A subset assertion alone is satisfied by a writer
    // that wrote one key; this names the ones that must be there.
    const { keys } = await exerciseLegacyReplica()
    for (const key of [...LEGACY_ENTITY_KEYS, LEGACY_CURSOR_KEY, LEGACY_OUTBOX_KEY]) {
      expect(keys, `writer did not produce ${key}`).toContain(key)
    }
  })

  it('classes the ui-state blob as a PREFERENCE, not replica state', () => {
    // ADR 6 D1 permits localStorage for prefs and D7 calls them lossy. Sweeping
    // this key in with the rest because it shares the prefix would delete the
    // user's layout on upgrade — the exact reason the predicate is a list
    // membership test rather than a prefix match.
    expect(isLegacyReplicaStateKey(LEGACY_UI_STATE_KEY)).toBe(false)
    expect(LEGACY_REPLICA_STATE_KEYS).not.toContain(LEGACY_UI_STATE_KEY)
  })
})

/**
 * The importer read against the REAL writer. Every other test of
 * `readLegacyReplica` builds its own blob, and a decoder tested only against
 * fixtures it also authored certifies its own guess about the format — the
 * POD-306 shape. Here the bytes come from TanStack DB's own
 * `localStorageCollectionOptions`, through the shipping replica.
 */
describe('ADR 6 D6 — readLegacyReplica against a store the real writer produced', () => {
  const COMMAND = { name: 'sessions.rename', version: 3, delivery: 'offline-eligible' } as const
  const ATTRIBUTION = {
    actor: { kind: 'user', userId: 'u_1' },
    onBehalfOf: 'u_1',
  } as unknown as Parameters<typeof readLegacyReplica>[1]['attribution']

  async function legacyStore(): Promise<{ getItem(key: string): string | null }> {
    const storage = observableStorage()
    const replica = createReplica({ storage: storage.api, enumerateKeys: () => storage.keys() })
    replica.applySnapshot('sessions', [session('sess_1')])
    replica.setCursor(42)
    replica.outboxStorage().save([
      { mutationId: 'mut_1', kind: 'sessions.rename', input: { title: 'renamed' }, queuedAt: 10 },
      { mutationId: 'mut_2', kind: 'sessions.rename', input: { title: 'later' }, queuedAt: 20 },
    ])
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    return storage.api
  }

  it('carries the queued mutations across, in FIFO order', async () => {
    const plan = readLegacyReplica(await legacyStore(), {
      resolveCommand: (kind) => (kind === 'sessions.rename' ? COMMAND : undefined),
      attribution: ATTRIBUTION,
    })
    expect(plan.verdict).toBe('import')
    expect(plan.outbox.map((e) => e.mutationId)).toEqual(['mut_1', 'mut_2'])
    expect(plan.outbox[0]?.input).toEqual({ title: 'renamed' })
    expect(plan.outbox[0]?.command.version).toBe(3)
  })

  it('DISCARDS the cursor the writer persisted, and says so', async () => {
    // ADR 2 D1: a bare integer is not a cursor. The importer must not synthesise
    // the feedId/epoch it lacks, and the client must be told it is
    // re-bootstrapping rather than left to discover it.
    const plan = readLegacyReplica(await legacyStore(), {
      resolveCommand: () => COMMAND,
      attribution: ATTRIBUTION,
    })
    expect(plan.cursorDiscarded).toBe(true)
    expect(plan.retireKeys).toContain(LEGACY_CURSOR_KEY)
  })

  it('retires the entity keys the writer produced, and NOT the ui-state key', async () => {
    const plan = readLegacyReplica(await legacyStore(), {
      resolveCommand: () => COMMAND,
      attribution: ATTRIBUTION,
    })
    expect(plan.retireKeys).toContain('podium.replica.sessions.v1')
    expect(plan.retireKeys).not.toContain(LEGACY_UI_STATE_KEY)
  })

  it('REFUSES an entry whose kind resolves to no contract, rather than guessing a version', async () => {
    const plan = readLegacyReplica(await legacyStore(), {
      resolveCommand: () => undefined,
      attribution: ATTRIBUTION,
    })
    expect(plan.outbox).toEqual([])
    expect(plan.rejected.map((r) => r.reason)).toEqual(['unknown-command', 'unknown-command'])
    // Still `discard` and still retiring keys: D6 clause 4 — never leave the
    // client stuck. Nothing survived, so it cold-bootstraps.
    expect(plan.verdict).toBe('discard')
    expect(plan.retireKeys.length).toBeGreaterThan(0)
  })
})
