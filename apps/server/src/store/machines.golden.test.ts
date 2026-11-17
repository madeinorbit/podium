/**
 * The machines aggregate's DECLARED-MODE columns and its mapper decisions,
 * pinned against the drizzle conversion [POD-3394, spec §6 rule 28].
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT ABOUT METHOD COVERAGE. The coverage
 * census (POD-3244) puts machines.ts at zero never-named and zero
 * executed-but-never-named methods — every method here is named by some test.
 * That is exactly what made it the wrong place to feel safe, because rule 28 is
 * about VALUES, not methods.
 *
 * THE HAZARD, in one line: drizzle applies the schema's declared modes, so an
 * `integer({ mode: 'boolean' })` column arrives as `true`/`false` and not as
 * `1`/`0`, and a mapper still comparing it to a number silently answers `false`
 * for every row. `true === 1` is `false`, and it typechecks wherever the row is
 * `unknown`.
 *
 * WHAT MAKES IT LETHAL IS THAT THE WRONG ANSWER IS THE COMMON ANSWER, and this
 * file exists because that was demonstrated here rather than assumed. With
 * `podiumManaged` compared to `1`, the ENTIRE store lane passed — 72 files, 919
 * tests — because `podium_managed` defaults to 1 and every fixture in the lane
 * seeds an ordinary managed machine. Only `supervised` was caught, by one test
 * that happens to report a desktop shell. So both boolean columns this file
 * reads are pinned below AT THEIR NON-DEFAULT VALUE, which is the only value
 * that can tell the two worlds apart.
 *
 * The three mapper DECISIONS that survive the conversion (spec §6 rule 6) are
 * pinned with them, because each is a nullability rule a conversion could
 * "tidy" into a default: an unowned machine, an unpinned update channel, and
 * components that are unrecorded rather than empty.
 */

import { asMachineId, type UserId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { openPeopleStoreSlice, type PeopleStoreSlice } from '../test-support/people-store-slice'
import { countStatements, expectConstantStatements, tallyOf } from '../test-support/statement-count'
import { withHarnessVersion } from './machines'

const owner = 'user-1' as UserId

async function register(
  store: PeopleStoreSlice,
  id: string,
  over: Partial<{ podiumManaged: boolean; ownerUserId: UserId | null }> = {},
) {
  await store.machines.upsertMachine({
    id,
    name: id,
    hostname: `${id}.local`,
    tokenHash: `hash-${id}`,
    ownerUserId: over.ownerUserId === undefined ? owner : over.ownerUserId,
    ...(over.podiumManaged === undefined ? {} : { podiumManaged: over.podiumManaged }),
  })
}

it('reads podium_managed as a boolean at BOTH values, including the non-default one', async () => {
  const store = await openPeopleStoreSlice()
  try {
    // The column defaults to 1/true, so an unmanaged machine is the ONLY case
    // that distinguishes a boolean read from a numeric comparison. Verified by
    // mutation: comparing this column to `1` passes the whole store lane
    // without this assertion.
    await register(store, 'unmanaged', { podiumManaged: false })
    await register(store, 'managed', { podiumManaged: true })
    await register(store, 'defaulted')

    expect((await store.machines.getMachine('unmanaged'))?.podiumManaged).toBe(false)
    expect((await store.machines.getMachine('managed'))?.podiumManaged).toBe(true)
    // Omitting the flag means managed, which is the caller-side default.
    expect((await store.machines.getMachine('defaulted'))?.podiumManaged).toBe(true)

    // Strictly boolean, never the underlying integer: `toBe(false)` above would
    // also hold for `0` under a loose comparison, this pins the type.
    expect(typeof (await store.machines.getMachine('unmanaged'))?.podiumManaged).toBe('boolean')

    const listed = await store.machines.listMachines()
    expect(listed.find((m) => m.id === 'unmanaged')?.podiumManaged).toBe(false)
    expect(listed.find((m) => m.id === 'managed')?.podiumManaged).toBe(true)
  } finally {
    await store.close()
  }
})

// The `supervised` golden test lived here. dev/mw's supervisor-presence
// migration DROPS that column (replaced by presence_source and
// service_assignment_json), so the test cannot be written against this schema
// any more. The property it existed to prove -- that drizzle's mode:'boolean'
// reads 0/1 back as false/true at BOTH values -- is still pinned by the
// podium_managed test directly above [POD-3416].

it('keeps an unowned machine unowned, and never substitutes an owner', async () => {
  const store = await openPeopleStoreSlice()
  try {
    await register(store, 'orphan', { ownerUserId: null })
    // POD-1079: null is MEANINGFUL and refuses `use` to everyone. A conversion
    // that coalesced it to a default would be the fail-open shape the nullable
    // column exists to avoid.
    expect(await store.machines.custodian('orphan')).toBeNull()

    // A returning hello does NOT transfer ownership, but it does fill a NULL.
    await register(store, 'orphan', { ownerUserId: owner })
    expect(await store.machines.custodian('orphan')).toBe(owner)
    await register(store, 'orphan', { ownerUserId: 'user-2' as UserId })
    expect(await store.machines.custodian('orphan')).toBe(owner)

    // The forced projection is the path that DOES move it, and null is quarantine.
    await store.machines.setMachineOwner('orphan', 'user-2' as UserId)
    expect(await store.machines.custodian('orphan')).toBe('user-2')
    await store.machines.setMachineOwner('orphan', null)
    expect(await store.machines.custodian('orphan')).toBeNull()
  } finally {
    await store.close()
  }
})

it('reads an unpinned update channel as null and keeps an unreadable one unpinned', async () => {
  const store = await openPeopleStoreSlice()
  try {
    await register(store, 'm1')
    // POD-1882: null means "follow the fleet default", not "no answer".
    expect((await store.machines.getMachine('m1'))?.updateChannelOverride).toBeNull()

    await store.machines.setUpdateChannel('m1', 'edge')
    expect((await store.machines.getMachine('m1'))?.updateChannelOverride).toBe('edge')
    await store.machines.setUpdateChannel('m1', null)
    expect((await store.machines.getMachine('m1'))?.updateChannelOverride).toBeNull()
  } finally {
    await store.close()
  }
})

it('derives components from explicit desired assignment', async () => {
  const store = await openPeopleStoreSlice()
  try {
    await register(store, 'm1')
    // New enrollment without an assignment is explicitly neither.
    expect((await store.machines.getMachine('m1'))?.components).toEqual([])

    expect(await store.machines.addMachineComponent('m1', 'daemon')).toBe(true)
    expect((await store.machines.getMachine('m1'))?.components).toEqual(['daemon'])

    // ADDITIVE and idempotent: the second writer must not evict the first, and
    // a repeated stamp reports no change so the caller skips its broadcast.
    expect(await store.machines.addMachineComponent('m1', 'server')).toBe(true)
    expect((await store.machines.getMachine('m1'))?.components).toEqual(['server', 'daemon'])
    expect(await store.machines.addMachineComponent('m1', 'daemon')).toBe(false)
    expect((await store.machines.getMachine('m1'))?.components).toEqual(['server', 'daemon'])

    expect(await store.machines.addMachineComponent('absent', 'daemon')).toBe(false)
  } finally {
    await store.close()
  }
})

it('finds no retired machine sentinel on a database a supported install can hold', async () => {
  const store = await openPeopleStoreSlice()
  try {
    await register(store, asMachineId('11111111-1111-4111-8111-111111111111'))
    // The boot refusal's input. Empty is the only answer a shipped Podium can
    // produce, and the check exists because the alternative to finding out is
    // not finding out.
    expect(await store.machines.legacyMachineSentinelSites()).toEqual([])
  } finally {
    await store.close()
  }
})

/**
 * THE HARNESS VERSIONS DOCUMENT, EDITED IN TYPESCRIPT, BYTE FOR BYTE AS `json_set` EDITED
 * IT [POD-6987, POD-6958 design 2.3 rule 6].
 *
 * The edit used to be one SQL `json_set`; Postgres has none for `json`, and `jsonb_set`
 * would reorder the document, so it moved to a read, an edit in TypeScript and a write.
 * The old statement is the oracle: SQLite runs it over each case and the TypeScript edit
 * must print the same text. The machine record's `harnessVersions` array follows the
 * document's key order, so order is part of what is compared.
 */
describe('the harness versions edit', () => {
  const ORACLE = `select json_set(coalesce(?1, '{}'), '$."' || ?2 || '"', json_object(
    'harness', ?2,
    'version', case when json_extract(coalesce(?1, '{}'), '$."' || ?2 || '".lastSeen') > ?4
      then json_extract(coalesce(?1, '{}'), '$."' || ?2 || '".version') else ?3 end,
    'firstSeen', min(coalesce(json_extract(coalesce(?1, '{}'), '$."' || ?2 || '".firstSeen'), ?4), ?4),
    'lastSeen', max(coalesce(json_extract(coalesce(?1, '{}'), '$."' || ?2 || '".lastSeen'), ?4), ?4)
  )) as document`
  const T1 = '2026-11-10T12:00:00.000Z'
  const T2 = '2026-11-10T13:00:00.000Z'
  const T0 = '2026-11-10T11:00:00.000Z'
  const entry = (harness: string, version: string, first: string, last: string) =>
    JSON.stringify({ harness, version, firstSeen: first, lastSeen: last })
  const cases: [stored: string | null, harness: string, version: string, probedAt: string][] = [
    [null, 'codex', '0.154.0', T1],
    ['{}', 'claude-code', '2.1.0', T1],
    [`{"codex":${entry('codex', '0.153.0', T0, T1)}}`, 'codex', '0.154.0', T2],
    // An older report keeps the stored version and only widens the window.
    [`{"codex":${entry('codex', '0.154.0', T1, T2)}}`, 'codex', '0.153.0', T0],
    [`{"codex":${entry('codex', '0.154.0', T1, T1)}}`, 'codex', '0.154.0', T1],
    // In place among others, which keep their order and their text.
    [
      `{"pi":${entry('pi', '1', T0, T0)},"codex":${entry('codex', '0.1', T0, T0)},"z":{"n":1.50,"s":"\\u00e9"}}`,
      'codex',
      '0.2',
      T1,
    ],
    // Appended after the others, integer-like keys included, in the stored order.
    [`{"2":${entry('2', 'a', T0, T0)},"1":${entry('1', 'b', T0, T0)}}`, '0', 'c', T1],
    // Whitespace outside strings goes, inside strings stays.
    [`{ "pi" : { "harness" : "pi", "version" : "a b" } }`, 'codex', '1', T1],
    // A member that is not an object is replaced whole; a repeated key's first one.
    ['{"codex":1,"codex":2}', 'codex', '1', T1],
    [`{"codex":{"lastSeen":"${T2}"}}`, 'codex', '1', T1],
    // A document that is not an object stays as it is.
    ['[1, 2]', 'codex', '1', T1],
    ['"text"', 'codex', '1', T1],
  ]

  it('prints what SQLite json_set printed, for every case', () => {
    const sqlite = openDatabase(':memory:')
    try {
      const oracle = sqlite.prepare(ORACLE)
      for (const [stored, harness, version, probedAt] of cases) {
        const expected = (oracle.get(stored, harness, version, probedAt) as { document: string })
          .document
        expect(withHarnessVersion(stored, { harness, version, probedAt }), String(stored)).toBe(
          expected,
        )
      }
    } finally {
      sqlite.close()
    }
  })

  it('refuses a malformed stored document, as json_set did', () => {
    expect(() =>
      withHarnessVersion('{"codex":', { harness: 'codex', version: '1', probedAt: T1 }),
    ).toThrow()
  })

  it('records each harness in report order, and a late report keeps the newer version', async () => {
    const store = await openPeopleStoreSlice()
    try {
      const id = asMachineId('22222222-2222-4222-8222-222222222222')
      await register(store, id)
      await store.machines.recordHarnessVersion(id, { harness: 'pi', version: '1.0', probedAt: T1 })
      await store.machines.recordHarnessVersion(id, {
        harness: 'codex',
        version: '0.154.0',
        probedAt: T1,
      })
      await store.machines.recordHarnessVersion(id, {
        harness: 'pi',
        version: '1.1',
        probedAt: T2,
      })
      await store.machines.recordHarnessVersion(id, {
        harness: 'pi',
        version: '0.9',
        probedAt: T0,
      })
      expect((await store.machines.getMachine(id))?.harnessVersions).toEqual([
        { harness: 'pi', version: '1.1', firstSeen: T0, lastSeen: T2 },
        { harness: 'codex', version: '0.154.0', firstSeen: T1, lastSeen: T1 },
      ])
      // A revoked or unknown machine is left alone.
      await store.machines.recordHarnessVersion(
        asMachineId('33333333-3333-4333-8333-333333333333'),
        {
          harness: 'pi',
          version: '1',
          probedAt: T1,
        },
      )
      expect(
        await store.machines.getMachine('33333333-3333-4333-8333-333333333333'),
      ).toBeUndefined()
    } finally {
      await store.close()
    }
  })

  /**
   * One read of the stored document and the write, whatever else the table holds: two
   * statements on both engines, one more than the single `json_set` UPDATE ran. The
   * Postgres leg runs the call in a transaction that drops its change capture (the test
   * has no commit layer to drain it); those two statements are the test's, not the
   * operation's, and are not counted.
   */
  it('runs two statements on both engines', async () => {
    const id = asMachineId('44444444-4444-4444-8444-444444444444')
    const drain = /sync_capture/
    await expectConstantStatements(
      {
        name: 'machines.recordHarnessVersion',
        // Each machine registers in its own transaction; 60 shows a count that does not
        // follow the table's size as well as 200 does, at a third of the setup.
        sizes: [3, 60],
        async setup(size) {
          const store = await openPeopleStoreSlice()
          for (let i = 0; i < size; i++)
            await register(
              store,
              asMachineId(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
            )
          await register(store, id)
          await store.machines.recordHarnessVersion(id, {
            harness: 'pi',
            version: '1.0',
            probedAt: T0,
          })
          return store
        },
        target: (store) => store.probeTarget,
        async count(store, run) {
          const counted = await countStatements(
            store.probeTarget,
            async () => await store.drained(async () => await run()),
          )
          const own = [...counted.byQuery].flatMap(([key, n]) =>
            store.engine === 'pg' && drain.test(key) && !key.startsWith('with ')
              ? []
              : Array.from({ length: n }, () => key),
          )
          return { result: counted.result, ...tallyOf(own) }
        },
        run: async (store) =>
          await store.undrained.machines.recordHarnessVersion(id, {
            harness: 'pi',
            version: '1.1',
            probedAt: T1,
          }),
        async check(_result, store) {
          expect((await store.machines.getMachine(id))?.harnessVersions).toEqual([
            { harness: 'pi', version: '1.1', firstSeen: T0, lastSeen: T1 },
          ])
        },
        teardown: async (store) => await store.close(),
      },
      2,
    )
  }, 60_000)
})
