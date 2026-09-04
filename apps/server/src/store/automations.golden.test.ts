/**
 * The automations aggregate's behaviour as it is TODAY, pinned before the
 * drizzle conversion [POD-3394, method §3 checklist item 10].
 *
 * Seven of this repository's thirteen methods are in the coverage census's
 * (POD-3244) "executed, but never named" column — `ownerOf`, `runOwnerOf`,
 * `insert`, `updateRun`, `listRuns`, `listAllRuns` and `lastSpawnedSessions`.
 * They reach a test only through `modules/automations/`, so nothing that goes
 * red on a conversion mentions them.
 *
 * FOUR SITES WHERE THE OBVIOUS CONVERSION IS NOT THE CURRENT BEHAVIOUR, each
 * with its own test below:
 *
 *   - `ownerOf` and `runOwnerOf` deliberately look THROUGH the tombstone; every
 *     other read filters `deleted_at IS NULL`. A conversion that makes the file
 *     consistent breaks the scoped removal feed exactly as POD-1509 describes,
 *     and it breaks it silently — the removal arrives as an empty watermark.
 *   - `lastSpawnedSessions` picks the latest run by MAX(rowid), NOT by
 *     MAX(fired_at), because two fires can share a timestamp. A conversion that
 *     reads "latest" as the timestamp is right in every test where the fires
 *     differ and wrong exactly when the overlap check matters.
 *   - `listRuns` breaks a fired_at tie by rowid DESC, so its order is total.
 *     Without the tie-break the page is whatever the engine returns.
 *   - `update` writes a null cron as the empty string and the mapper reads the
 *     empty string back as null. Neither half is meaningful alone, so a
 *     conversion has to move both or neither.
 */

import type {
  AutomationId,
  AutomationRunId,
  AutomationRunOutcome,
  SessionId,
  UserId,
} from '@podium/model'
import { expect, it } from 'vitest'
import type { AutomationRow, AutomationRunRow } from './automations'
import { openTestStore } from '../test-support/open-test-store'

const owner = 'user-1' as UserId
const other = 'user-2' as UserId

function automation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 'auto-1' as AutomationId,
    name: 'nightly',
    enabled: true,
    repoPath: '/repo',
    scheduleKind: 'cron',
    cron: '0 3 * * *',
    runAt: null,
    targetSessionId: null,
    agentKind: 'claude-code',
    model: 'auto',
    effort: 'auto',
    prompt: 'do the nightly thing',
    sessionMode: 'fresh',
    nextRunAt: '2026-09-02T03:00:00.000Z',
    lastRunAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ownerUserId: owner,
    createdByActor: 'user:sole',
    createdByOnBehalfOf: owner,
    ...overrides,
  }
}

function run(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  return {
    id: 'run-1' as AutomationRunId,
    automationId: 'auto-1' as AutomationId,
    firedAt: '2026-09-01T03:00:00.000Z',
    sessionId: null,
    outcome: 'spawned' as AutomationRunOutcome,
    detail: null,
    actor: 'system:automation',
    onBehalfOf: owner,
    ...overrides,
  }
}

it('round-trips an automation through insert, including the boolean and the nullable columns', async () => {
  const store = await openTestStore(':memory:')
  try {
    expect(store.automations.get('auto-1')).toBeUndefined()

    const row = automation()
    store.automations.insert(row)
    expect(store.automations.get('auto-1')).toEqual(row)

    // `enabled` is an INTEGER column and a boolean in the row type; the mapper
    // is what bridges them, in both directions.
    store.automations.insert(automation({ id: 'auto-2' as AutomationId, enabled: false }))
    expect(store.automations.get('auto-2')?.enabled).toBe(false)
    expect(store.automations.get('auto-1')?.enabled).toBe(true)

    // Every nullable column survives as null rather than becoming undefined.
    store.automations.insert(
      automation({
        id: 'auto-3' as AutomationId,
        repoPath: null,
        runAt: null,
        targetSessionId: null,
        nextRunAt: null,
        lastRunAt: null,
      }),
    )
    const bare = store.automations.get('auto-3')
    expect(bare).toMatchObject({
      repoPath: null,
      runAt: null,
      targetSessionId: null,
      nextRunAt: null,
      lastRunAt: null,
    })
  } finally {
    store.close()
  }
})

it('lists live automations oldest first and hides the tombstoned ones', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.automations.insert(automation({ id: 'b' as AutomationId, createdAt: '2026-09-01T02:00:00.000Z' }))
    store.automations.insert(automation({ id: 'a' as AutomationId, createdAt: '2026-09-01T01:00:00.000Z' }))
    store.automations.insert(automation({ id: 'c' as AutomationId, createdAt: '2026-09-01T03:00:00.000Z' }))

    expect(store.automations.list().map((a) => a.id)).toEqual(['a', 'b', 'c'])

    expect(store.automations.remove('b', '2026-09-01T04:00:00.000Z')).toBe(true)
    expect(store.automations.list().map((a) => a.id)).toEqual(['a', 'c'])
    expect(store.automations.get('b')).toBeUndefined()

    // Tombstoning is idempotent and says so: the second call finds nothing live.
    expect(store.automations.remove('b', '2026-09-01T05:00:00.000Z')).toBe(false)
    expect(store.automations.remove('never-existed', '2026-09-01T05:00:00.000Z')).toBe(false)
  } finally {
    store.close()
  }
})

it('answers ownership through the tombstone, which is the one fact that outlives an automation', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.automations.insert(automation())
    store.automations.insert(automation({ id: 'auto-2' as AutomationId, ownerUserId: other }))
    store.automations.addRun(run())
    store.automations.addRun(run({ id: 'run-2' as AutomationRunId, automationId: 'auto-2' as AutomationId }))

    expect(store.automations.ownerOf('auto-1')).toBe(owner)
    expect(store.automations.ownerOf('auto-2')).toBe(other)
    expect(store.automations.runOwnerOf('run-1')).toBe(owner)
    expect(store.automations.runOwnerOf('run-2')).toBe(other)

    store.automations.remove('auto-1', '2026-09-01T04:00:00.000Z')

    // THE POINT OF THE TOMBSTONE. `get` and `getRun` are gone; the owner is not.
    // A conversion that adds `deleted_at IS NULL` here for consistency turns the
    // scoped feed's removal into an empty watermark, which nothing else notices.
    expect(store.automations.get('auto-1')).toBeUndefined()
    expect(store.automations.getRun('run-1')).toBeUndefined()
    expect(store.automations.ownerOf('auto-1')).toBe(owner)
    expect(store.automations.runOwnerOf('run-1')).toBe(owner)

    expect(store.automations.ownerOf('never-existed')).toBeUndefined()
    expect(store.automations.runOwnerOf('never-existed')).toBeUndefined()
  } finally {
    store.close()
  }
})

it('updates every mutable column and round-trips a null cron through the empty string', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.automations.insert(automation())
    const patched = automation({
      name: 'renamed',
      enabled: false,
      repoPath: '/elsewhere',
      scheduleKind: 'once',
      cron: null,
      runAt: '2026-09-05T00:00:00.000Z',
      targetSessionId: 'sess-1' as SessionId,
      agentKind: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      prompt: 'a different prompt',
      sessionMode: 'resume',
      nextRunAt: '2026-09-05T00:00:00.000Z',
      lastRunAt: '2026-09-02T03:00:00.000Z',
    })
    store.automations.update(patched)

    // The write stores '' for a null cron and the read maps '' back to null, so
    // the row the caller gets back equals the row it wrote. Both halves or
    // neither: keeping only the write leaves callers an empty string.
    expect(store.automations.get('auto-1')).toEqual(patched)

    // The identity columns are NOT in the update's SET list.
    expect(store.automations.get('auto-1')?.createdAt).toBe('2026-09-01T00:00:00.000Z')
    expect(store.automations.get('auto-1')?.ownerUserId).toBe(owner)
    expect(store.automations.get('auto-1')?.createdByActor).toBe('user:sole')
  } finally {
    store.close()
  }
})

it('pages an automation’s runs newest first with a total order, and lists all runs oldest first', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.automations.insert(automation())
    store.automations.insert(automation({ id: 'auto-2' as AutomationId }))
    // Two runs sharing a timestamp: the tie-break is what makes the page stable.
    store.automations.addRun(run({ id: 'r1' as AutomationRunId, firedAt: '2026-09-01T01:00:00.000Z' }))
    store.automations.addRun(run({ id: 'r2' as AutomationRunId, firedAt: '2026-09-01T02:00:00.000Z' }))
    store.automations.addRun(run({ id: 'r3' as AutomationRunId, firedAt: '2026-09-01T02:00:00.000Z' }))
    store.automations.addRun(
      run({ id: 'r4' as AutomationRunId, automationId: 'auto-2' as AutomationId, firedAt: '2026-09-01T03:00:00.000Z' }),
    )

    // r3 was inserted after r2 and shares its timestamp, so it comes first.
    expect(store.automations.listRuns('auto-1' as AutomationId).map((r) => r.id)).toEqual([
      'r3',
      'r2',
      'r1',
    ])
    expect(store.automations.listRuns('auto-1' as AutomationId, 2).map((r) => r.id)).toEqual(['r3', 'r2'])
    expect(store.automations.listRuns('auto-2' as AutomationId).map((r) => r.id)).toEqual(['r4'])

    // The full-truth read is the other direction, and it spans automations.
    expect(store.automations.listAllRuns().map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
  } finally {
    store.close()
  }
})

it('tombstones an automation’s runs with it, and refuses to finalize a tombstoned run', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.automations.insert(automation())
    store.automations.addRun(run({ id: 'r1' as AutomationRunId, outcome: 'missed' }))

    store.automations.updateRun('r1', {
      sessionId: 'sess-1' as SessionId,
      outcome: 'spawned' as AutomationRunOutcome,
      detail: 'the detail',
    })
    expect(store.automations.getRun('r1')).toMatchObject({
      sessionId: 'sess-1',
      outcome: 'spawned',
      detail: 'the detail',
    })

    store.automations.remove('auto-1', '2026-09-01T04:00:00.000Z')
    // The runs leave with the parent. They used to leave through ON DELETE
    // CASCADE, which no longer fires now that the parent row stays.
    expect(store.automations.getRun('r1')).toBeUndefined()
    expect(store.automations.listAllRuns()).toEqual([])
    expect(store.automations.listRuns('auto-1' as AutomationId)).toEqual([])

    // Finalizing a tombstoned run is a no-op, not a resurrection.
    store.automations.updateRun('r1', {
      sessionId: 'sess-2' as SessionId,
      outcome: 'error' as AutomationRunOutcome,
      detail: 'too late',
    })
    expect(store.automations.getRun('r1')).toBeUndefined()
  } finally {
    store.close()
  }
})

it('names the last spawned session per automation by insertion order, not by timestamp', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.automations.insert(automation())
    store.automations.insert(automation({ id: 'auto-2' as AutomationId }))
    store.automations.insert(automation({ id: 'auto-3' as AutomationId }))

    // THE DISCRIMINATING CASE, and it has to be the timestamps DISAGREEING with
    // insertion order rather than merely tying. A tie does not separate the two
    // rules: `MAX(fired_at)` returns both rows and the Map keeps whichever came
    // last, which happens to be the right answer. So r2 is inserted after r1 and
    // stamped EARLIER — a fire recorded out of order — and now the two rules give
    // different sessions. Verified by mutation: keying on MAX(fired_at) survives
    // the tie and dies here.
    store.automations.addRun(
      run({
        id: 'r1' as AutomationRunId,
        firedAt: '2026-09-01T03:00:00.000Z',
        sessionId: 'sess-first' as SessionId,
      }),
    )
    store.automations.addRun(
      run({
        id: 'r2' as AutomationRunId,
        firedAt: '2026-09-01T02:00:00.000Z',
        sessionId: 'sess-second' as SessionId,
      }),
    )
    // Not spawned, and spawned-without-a-session: neither is the overlap input.
    store.automations.addRun(
      run({
        id: 'r3' as AutomationRunId,
        automationId: 'auto-2' as AutomationId,
        outcome: 'missed' as AutomationRunOutcome,
        sessionId: 'sess-missed' as SessionId,
      }),
    )
    store.automations.addRun(
      run({ id: 'r4' as AutomationRunId, automationId: 'auto-3' as AutomationId, sessionId: null }),
    )

    const last = store.automations.lastSpawnedSessions()
    // The last INSERTED run, even though its timestamp is the older of the two.
    expect(last.get('auto-1' as AutomationId)).toBe('sess-second')
    // An automation that never spawned with a session is ABSENT, not null.
    expect(last.has('auto-2' as AutomationId)).toBe(false)
    expect(last.has('auto-3' as AutomationId)).toBe(false)

    // A tombstoned automation's runs leave the map with it.
    store.automations.remove('auto-1', '2026-09-01T04:00:00.000Z')
    expect(store.automations.lastSpawnedSessions().size).toBe(0)
  } finally {
    store.close()
  }
})
