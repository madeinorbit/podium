/**
 * QUOTA-FULL (ADR 6 D4.4), against a denial the storage engine actually issues.
 *
 * D4.4 has five clauses and this file asserts each one separately, because they fail
 * independently and an adapter can satisfy any four while breaking the fifth:
 *
 *   1. the failing operation does not partially apply
 *   2. durability flips to `degraded-memory` for the remainder of the session
 *   3. the UI is EXPLICITLY informed
 *   4. the adapter MUST NOT fall back to AsyncStorage for the replica payload
 *   5. next cold start hydrates from durable storage if it is usable again
 *
 * ─── WHY THE DENIAL IS INJECTED WHERE IT IS ──────────────────────────────────
 *
 * At statement index 1 of a live transaction whose index 0 has ALREADY BEEN ISSUED to
 * the engine. A denial injected before `BEGIN IMMEDIATE` would make clause 1 vacuous
 * — nothing was applied because nothing was attempted — which is the "quota test that
 * never reaches the quota" this run has paid for elsewhere. Here the first write
 * really is in flight, and it is SQLite's `ROLLBACK` of a real transaction that takes
 * it back out; clause 1 is therefore an observation about the engine.
 *
 * The counterpart lives in `conformance.ts`: the suite's `setWritesDenied` refuses at
 * the PORT, before staging, which is the semantics `suite.ts` asserts. Two injectors,
 * two instants, two different claims.
 *
 * ─── CLAUSE 4 NEEDS A DIFFERENT INSTRUMENT FROM THE WEB'S, AND WHY ───────────
 *
 * POD-374 could spy on `localStorage` because it is a GLOBAL the adapter would have
 * to reach for. On mobile the forbidden store is `AsyncStorage`, which is an IMPORTED
 * MODULE — no global to intercept, so a runtime spy cannot see it and an absence
 * "proved" by such a spy would be vacuous. So clause 4 is enforced by a SOURCE-TEXT
 * detector over this directory, and the detector carries both controls a source scan
 * needs: one proving it FINDS every spelling of the concept planted in code, and one
 * proving it does not fire on the prose in these files, which document the
 * prohibition at length. The localStorage global spy is kept as well, because
 * `apps/mobile` also ships to react-native-web where that global exists.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actorUser, asUserId } from '@podium/model'
import type { MutationId } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import { type DurabilityDegradation, SqliteSyncStore } from './store'
import {
  DiskFullError,
  FaultySqlDatabase,
  freshDatabaseFile,
  readDurable,
  sqliteEngine,
} from './test-support'

const PRINCIPAL = asUserId('ada')
const M1: MutationId = 'm-1' as MutationId
const M2: MutationId = 'm-2' as MutationId
const CURSOR_1: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }
const CURSOR_2: Cursor = { feedId: 'feed', epoch: 'e1', seq: 2 }

const record = (mutationId: MutationId): OutboxRecord => ({
  mutationId,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(PRINCIPAL), onBehalfOf: PRINCIPAL },
  state: 'queued',
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

describe('mobile SQLite adapter — quota-full (ADR 6 D4.4)', () => {
  let file: string
  let cleanup: () => void
  let degradations: DurabilityDegradation[]
  let faulty: FaultySqlDatabase

  beforeEach(() => {
    const fresh = freshDatabaseFile()
    file = fresh.file
    cleanup = fresh.cleanup
    degradations = []
  })

  afterEach(() => {
    cleanup()
  })

  const open = async (): Promise<SqliteSyncStore> =>
    await SqliteSyncStore.open({
      openDatabase: () => {
        faulty = new FaultySqlDatabase(sqliteEngine.open(file))
        return faulty
      },
      deleteDatabase: () => {
        throw new Error('these cases never poison the file')
      },
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })

  /** A two-region commit: one outbox put, then one entity upsert plus the cursor. */
  const commit = async (store: SqliteSyncStore, id: MutationId, cursor: Cursor, v: number) => {
    const view = store.viewFor(PRINCIPAL)
    await store.unitOfWork.transact(async (span) => {
      await view.outbox.apply(
        { put: [record(id)], expect: [{ mutationId: id, expect: 'absent' }] },
        span,
      )
      view.cache.applyAtomic(
        {
          operations: [
            {
              kind: 'upsert',
              entity: 'issue',
              entityId: 'ADA-1',
              value: { v },
              provenance: { seq: cursor.seq },
            },
          ],
          cursor,
        },
        span,
      )
    })
  }

  const durableRows = () => {
    const rows = readDurable(file)
    return {
      entities: rows.entities.map((r) => r.value),
      cursor: rows.cursors.find((r) => r.principal === PRINCIPAL)?.cursor,
      outbox: rows.outbox.map((r) => r.mutationId),
    }
  }

  it('POSITIVE CONTROL — with space available the same commit lands in all regions', async () => {
    const store = await open()
    await commit(store, M1, CURSOR_1, 0)
    expect(durableRows()).toEqual({ entities: [{ v: 0 }], cursor: CURSOR_1, outbox: [M1] })
    expect(degradations).toEqual([])
    expect(store.durability()).toBe('durable')
    store.close()
  })

  it('D4.4.1 — a denial mid-transaction does not partially apply, in any region', async () => {
    const store = await open()
    await commit(store, M1, CURSOR_1, 0)
    const before = durableRows()

    // The denial lands at statement 1, so statement 0 of the SAME transaction has
    // already been issued to the engine and accepted.
    const issuedBefore = faulty.writesIssued
    faulty.denyWriteAt({ at: 1 })
    await expect(commit(store, M2, CURSOR_2, 1)).rejects.toThrow(/disk is full/i)

    // The transaction really did get a write in before the denial — otherwise the
    // clause below is about a transaction that never touched the store.
    expect(faulty.writesIssued - issuedBefore).toBeGreaterThanOrEqual(2)
    expect(faulty.denials).toBe(1)

    // Byte-identical: the earlier commit intact, the denied one absent everywhere.
    expect(durableRows()).toEqual(before)
    store.close()
  })

  it('D4.4.2/3 — durability flips to degraded-memory for the session, and says so ONCE', async () => {
    const store = await open()
    faulty.denyWriteAt({ at: 0 })
    await expect(commit(store, M1, CURSOR_1, 0)).rejects.toThrow(/disk is full/i)

    expect(store.durability()).toBe('degraded-memory')
    expect(degradations).toHaveLength(1)
    expect(degradations[0]).toMatchObject({ mode: 'degraded-memory', cause: 'quota' })
    expect((degradations[0] as DurabilityDegradation).error).toBeInstanceOf(DiskFullError)

    // STICKY, and reported once. A second failure must not re-announce a state the UI
    // is already showing, and must not silently return to claiming durability.
    const afterFirst = faulty.writesIssued
    await commit(store, M2, CURSOR_2, 1)
    expect(store.durability()).toBe('degraded-memory')
    expect(degradations).toHaveLength(1)

    // The session CONTINUES: the write applied in memory and reached SQLite not at
    // all. That is what `degraded-memory` means — not "every write now throws".
    const view = store.viewFor(PRINCIPAL)
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 1 })
    expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual([M2])
    expect(faulty.writesIssued).toBe(afterFirst)
    store.close()
  })

  it('D4.4.5 — the next cold start finds exactly what committed before the quota hit', async () => {
    const store = await open()
    await commit(store, M1, CURSOR_1, 0)
    faulty.denyWriteAt({ at: 0 })
    await expect(commit(store, M2, CURSOR_2, 1)).rejects.toThrow(/disk is full/i)
    // Work done while degraded lives in memory only, by design.
    await commit(store, M2, CURSOR_2, 1)
    store.close()

    // The device is restarted with space free again. Durable storage is usable, so the
    // client hydrates from it — and finds the pre-quota state, not the degraded
    // session's memory. "Reload may cold-start" is exactly this.
    const reopened = await open()
    const view = reopened.viewFor(PRINCIPAL)
    expect(reopened.durability()).toBe('durable')
    expect(view.cache.read('issue', 'ADA-1')?.value).toEqual({ v: 0 })
    expect(view.cache.readCursor()).toEqual(CURSOR_1)
    expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual([M1])
    reopened.close()
  })

  describe('D4.4.4 — degraded mode is in-memory ONLY, never AsyncStorage', () => {
    /**
     * Every spelling the CONCEPT can arrive as, not the one name a first draft would
     * have grepped for. A detector that covered `AsyncStorage` alone would miss the
     * import specifier, the RN-web global, and the two neighbouring key-value stores
     * an implementer under quota pressure would reach for next.
     */
    const FORBIDDEN = [
      /AsyncStorage/,
      /@react-native-async-storage/,
      /\basync-storage\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bSecureStore\b/,
      /expo-secure-store/,
      /\bMMKV\b/,
    ]

    /** Comments stripped, for the reason `check-boundaries` strips them: these files
     *  DOCUMENT the prohibition, and a detector that read prose would fire on the
     *  very text explaining why it exists. */
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

    const offendersIn = (source: string): string[] =>
      FORBIDDEN.filter((pattern) => pattern.test(stripComments(source))).map(String)

    it('the detector CAN say yes — every spelling planted in CODE is caught', () => {
      // The positive control the whole clause rests on. An absence reported by an
      // instrument that cannot report a presence is not evidence.
      const planted = [
        `import AsyncStorage from '@react-native-async-storage/async-storage'`,
        `globalThis.localStorage.setItem('podium.replica', payload)`,
        `window.sessionStorage.setItem('x', 'y')`,
        `SecureStore.setItemAsync('k', 'v')`,
        `import * as S from 'expo-secure-store'`,
        `const store = new MMKV()`,
      ].join('\n')
      expect(offendersIn(planted)).toHaveLength(FORBIDDEN.length)
    })

    it('…and it does NOT fire on the prose these files are full of', () => {
      // The paired half. Without it the clause below could be satisfied by a detector
      // whose comment-stripping had quietly swallowed the entire file.
      expect(offendersIn(`// never AsyncStorage, never localStorage — ADR 6 D4.4.4`)).toEqual([])
      expect(offendersIn(`/* AsyncStorage is forbidden here */`)).toEqual([])
      // …and the stripper has not swallowed code: a needle OUTSIDE a comment in the
      // same text is still found.
      expect(offendersIn(`// never AsyncStorage\nconst x = new MMKV()`)).toEqual(['/\\bMMKV\\b/'])
    })

    it('no source file in this adapter names any of them', () => {
      const directory = new URL('.', import.meta.url).pathname
      const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
      // The scan is only as good as its reach: if the directory listing ever comes
      // back short, the clean result below means nothing.
      expect(files.length).toBeGreaterThanOrEqual(8)
      const offenders = files.flatMap((name) => {
        // This file plants the needles above, so scanning it would report its own
        // controls. Every OTHER file in the directory is in scope.
        if (name === 'quota.test.ts') return []
        const found = offendersIn(readFileSync(join(directory, name), 'utf8'))
        return found.map((pattern) => `${name}: ${pattern}`)
      })
      expect(offenders).toEqual([])
    })

    it('a whole degraded session never touches the localStorage global either', async () => {
      // A recording stand-in on the one global react-native-web would provide.
      // `Reflect.get` on ANY key is recorded, so `setItem`, `getItem` and a bare
      // property read all count — a spy that only watched `setItem` would miss an
      // adapter that read the key to decide whether to write it.
      const touched: string[] = []
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: new Proxy(
          {},
          {
            get: (_target, key) => {
              touched.push(String(key))
              return () => undefined
            },
            set: (_target, key) => {
              touched.push(String(key))
              return true
            },
          },
        ),
      })
      try {
        // The spy's own positive control, in the same case so it cannot drift away
        // from the assertion it guards.
        ;(
          globalThis as { localStorage?: { setItem: (k: string, v: string) => void } }
        ).localStorage?.setItem('podium.probe', 'x')
        expect(touched).toContain('setItem')
        touched.length = 0

        const store = await open()
        faulty.denyWriteAt({ at: 0 })
        await expect(commit(store, M1, CURSOR_1, 0)).rejects.toThrow(/disk is full/i)
        expect(store.durability()).toBe('degraded-memory')

        // Everything a client does after the denial: more writes, reads, a discard.
        await commit(store, M2, CURSOR_2, 1)
        const view = store.viewFor(PRINCIPAL)
        view.cache.readEntities()
        await view.outbox.read()
        view.cache.discardCache()
        store.close()

        expect(touched).toEqual([])
      } finally {
        Reflect.deleteProperty(globalThis, 'localStorage')
      }
    })
  })
})
