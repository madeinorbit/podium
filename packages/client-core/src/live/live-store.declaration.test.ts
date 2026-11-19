import { readFileSync } from 'node:fs'
import { defineRecord, livePartsOf, RECORDS, recordOf } from '@podium/model'
import { TOPIC_KINDS } from '@podium/protocol'
import { autorun } from 'mobx'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  knownReading,
  LiveStore,
  type LiveTopicKind,
  type Reading,
  RecordLiveStore,
  unknownReading,
} from './live-store'
import { LegacyLiveStore } from './live-store.before.test.fixture'

// This one declaration line adds an entire live value: no store registration,
// map, demand callback or switch arm. It is deliberately not a production topic.
const session = recordOf('session')
const fixture = defineRecord({
  kind: 'session',
  replicaKind: 'sessions',
  schema: session.schema,
  key: 'sessionId',
  group: 'byRule',
  why: 'Test-only session with one extra live value.',
  liveReadings: {
    ...session.liveReadings,
    'session.fixture': z.object({ sample: z.number() }),
  },
})

const values = {
  'machine.condition': { online: true, since: 'now', lastSeenAt: 'later' },
  'machine.metrics': { machineId: 'm1', hostname: 'host', sampledAt: 'now' },
  'session.condition': {
    busy: true,
    requestsGated: 2,
    lastInputAt: 'now',
    contextUsagePercent: 47,
  },
  'session.terminalState': {
    controller: null,
    geometry: { cols: 132, rows: 43 },
    exit: { code: 0 },
  },
  'account.quota': { machines: [] },
  'account.usage': { hostname: 'host', buckets: [] },
} satisfies Record<LiveTopicKind, unknown>

type Store = LiveStore | LegacyLiveStore
function snapshot(store: Store) {
  return {
    connection: store.connection,
    outbox: store.outbox,
    quota: store.quota,
    usage: store.usage(),
    quotaUntil: store.quotaUsedUpUntil,
    unsent: store.unsyncedChangeCount,
    machines: [...store.machineConditions],
    metrics: [...store.machineMetrics],
    sessions: [...store.sessionConditions],
    terminals: [...store.sessionTerminalStates],
  }
}

function sameAnswers(old: LegacyLiveStore, next: LiveStore) {
  expect(snapshot(next)).toEqual(snapshot(old))
}

describe('declaration-driven live parts', () => {
  it('generates protocol payloads from the record declaration, including every live field', () => {
    for (const { topic, schema } of livePartsOf(RECORDS)) {
      expect(TOPIC_KINDS[topic].payload, topic).toBe(schema)
    }
    for (const field of [
      'busy',
      'requestsGated',
      'lastInputAt',
      'contextUsagePercent',
      'controller',
      'controllerIdentity',
      'geometry',
      'exit',
    ])
      expect(session.partOf(field), field).toBe('live')
    expect(session.fields).not.toContain('busy')
    expect(session.fields).not.toContain('geometry')
  })

  it('adds and watches a declaration-only value with the same generic store', () => {
    const demand: unknown[] = []
    const store = new RecordLiveStore([fixture] as const, (kind, id, watched) => {
      demand.push([kind, id, watched])
      if (!watched) store.applyTopic(kind, id, undefined)
    })
    expect(store.recordReading('session.fixture', 's1')).toBeUndefined()
    expect(demand).toEqual([])
    const seen: unknown[] = []
    const first = autorun(() => seen.push(store.recordReading('session.fixture', 's1')))
    const second = autorun(() => void store.recordReading('session.fixture', 's1'))
    try {
      expect(demand).toEqual([['session.fixture', 's1', true]])
      expect(store.watchedRecords()).toEqual([{ kind: 'session.fixture', id: 's1' }])
      store.applyTopic('session.fixture', 's1', knownReading({ sample: 42 }, 7))
      expect(seen.at(-1)).toEqual({ known: true, value: { sample: 42 }, at: 7 })
      expectTypeOf(store.recordReading('session.fixture', 's1')).toEqualTypeOf<
        Reading<{ sample: number }> | undefined
      >()
      first()
      expect(demand).toHaveLength(1)
      second()
      expect(demand.at(-1)).toEqual(['session.fixture', 's1', false])
      expect(store.readingsOf('session.fixture').has('s1')).toBe(false)
      expect(store.watchedRecords()).toEqual([])
    } finally {
      first()
      second()
      store.dispose()
    }
  })

  it('uses the same first/last demand hook for every declared part and keeps IDs independent', () => {
    const demand: unknown[] = []
    const store = new RecordLiveStore(RECORDS, (...args) => demand.push(args))
    try {
      for (const { topic } of livePartsOf(RECORDS)) {
        demand.length = 0
        store.recordReading(topic, 'a')
        expect(demand).toEqual([])
        const a = autorun(() => void store.recordReading(topic, 'a'))
        const again = autorun(() => void store.recordReading(topic, 'a'))
        const b = autorun(() => void store.recordReading(topic, 'b'))
        expect(demand).toEqual([
          [topic, 'a', true],
          [topic, 'b', true],
        ])
        a()
        expect(demand).toHaveLength(2)
        b()
        expect(store.watchedIds(topic)).toEqual(['a'])
        again()
        expect(demand.slice(2)).toEqual([
          [topic, 'b', false],
          [topic, 'a', false],
        ])
      }
      const stop = autorun(() => void store.recordReading('session.condition', 'a'))
      const before = demand.length
      store.dispose()
      stop()
      store.recordReading('session.condition', 'a')
      store.applyTopic('session.condition', 'a', knownReading({ busy: true, requestsGated: 0 }, 1))
      expect(demand).toHaveLength(before)
      expect(store.readingsOf('session.condition').size).toBe(0)
    } finally {
      store.dispose()
    }
  })

  it('refuses two declarations claiming the same topic', () => {
    expect(() => livePartsOf([session, session])).toThrow(/declared twice/)
  })

  it('has no hand-written per-topic map, dispatch or demand callback (source grep)', () => {
    const check = (source: string) => {
      expect(source.match(/observable\.map</g)).toHaveLength(1)
      expect(source).not.toMatch(
        /(?:machineConditions|machineMetrics|sessionConditions|sessionTerminalStates)\s*=\s*observable/,
      )
      expect(source).not.toMatch(/case ['"](?:machine|session)\./)
      expect(source).not.toMatch(/onMetricsDemand|onSessionDemand/)
    }
    check(readFileSync(new URL('./live-store.ts', import.meta.url), 'utf8'))
    // The same census rejects the exact code it replaces.
    expect(() =>
      check(readFileSync(new URL('./live-store.before.test.fixture.ts', import.meta.url), 'utf8')),
    ).toThrow()
  })
})

describe('old/new live-store answer parity', () => {
  it('agrees on the same readings, pending carry, disconnect, deletion and sign-out fixtures', () => {
    const old = new LegacyLiveStore({ now: () => 9 })
    const next = new LiveStore({ now: () => 9 })
    try {
      sameAnswers(old, next)
      for (const kind of Object.keys(values) as LiveTopicKind[]) {
        const value = values[kind]
        const steps: Array<Reading<unknown> | undefined> = [
          unknownReading(1),
          knownReading(value, 2),
          unknownReading(3),
          unknownReading(4, value),
          knownReading(value, 5),
          undefined,
        ]
        for (const reading of steps) {
          old.applyTopic(kind, 'a', reading)
          next.applyTopic(kind, 'a', reading)
          sameAnswers(old, next)
        }
        old.applyTopic(kind, 'b', knownReading(value, 6))
        next.applyTopic(kind, 'b', knownReading(value, 6))
      }
      for (const store of [old, next]) {
        store.setConnection({ state: 'offline', since: 8, serverBuild: 'test' })
        store.setOutbox({ pending: 3, deadLetters: [] })
      }
      sameAnswers(old, next)
      // Prove the parity check fails if the replacement gives a wrong answer.
      next.applyTopic('session.condition', 'b', knownReading({ busy: false, requestsGated: 0 }, 6))
      expect(() => sameAnswers(old, next)).toThrow()
      next.applyTopic('session.condition', 'b', knownReading(values['session.condition'], 6))
      sameAnswers(old, next)
      old.dispose()
      next.dispose()
      for (const store of [old, next])
        store.applyTopic('machine.condition', 'a', knownReading(values['machine.condition'], 10))
      sameAnswers(old, next)
    } finally {
      old.dispose()
      next.dispose()
    }
  })

  it('reports identical demand for existing model readers', () => {
    const previous: unknown[] = []
    const current: unknown[] = []
    const old = new LegacyLiveStore({
      onMetricsDemand: (id, on) => previous.push(['machine.metrics', id, on]),
      onSessionDemand: (...args) => previous.push(args),
      onUsageDemand: (on) => previous.push(['account.usage', 'me', on]),
    })
    const next = new LiveStore({
      onRecordDemand: (...args) => current.push(args),
      onUsageDemand: (on) => current.push(['account.usage', 'me', on]),
    })
    for (const read of [
      (store: Store) => store.metricsOf('m1'),
      (store: Store) => store.sessionConditionOf('s1'),
      (store: Store) => store.sessionTerminalStateOf('s1'),
      (store: Store) => store.usage(),
    ]) {
      const a = autorun(() => void read(old))
      const b = autorun(() => void read(next))
      const againA = autorun(() => void read(old))
      const againB = autorun(() => void read(next))
      expect(current).toEqual(previous)
      a()
      b()
      expect(current).toEqual(previous)
      againA()
      againB()
      expect(current).toEqual(previous)
    }
    old.dispose()
    next.dispose()
  })
})
