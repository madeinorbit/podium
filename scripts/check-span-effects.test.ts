/**
 * Fixtures for the span-effect lint (POD-3332).
 *
 * Each test is one sentence of spec §6 rule 19, or one of the ways a rule of
 * this shape is known to fail. The two that matter most are the pair the
 * coordinator's note is about: a diagnostic `log.warn` inside a span must NOT be
 * flagged (`store/helpers.ts`'s quarantine warnings are the live example), and
 * an observable effect must be — because a rule that flags every call gets
 * turned off and a rule that flags observable effects is worth having.
 *
 * The rest pin what the execution method says a name-matching scan cannot do:
 * follow a call made through a local `const` or a closure (POD-3257's own
 * finding, on its own work), and not flood on `Map.get`.
 */

import { describe, expect, it } from 'vitest'
import { ACCEPTED, judge, keyOf } from './check-span-effects'
import {
  type AnalysisResult,
  analyze,
  createFixtureProgram,
  FIXTURE_ROOT,
  type OpenerSpec,
  PORT_CAPABILITIES,
  type PortRule,
  SPAN_OPENERS,
} from './span-effect-graph'

/* ------------------------------------------------------------- the fixture */

/**
 * The smallest world with a span, a mechanism, a diagnostic and an effect.
 *
 * The paths are the real ones, because the opener, registrar and package tables
 * key on declaration paths — so the fixture exercises the same lookup the
 * production run does rather than a parallel one.
 */
const WORLD: Record<string, string> = {
  'apps/server/src/store.ts': `
    export class SessionStore {
      transact<T>(fn: () => T): T { return fn() }
      insert(row: string): void { void row }
    }
  `,
  'apps/server/src/store/executor/executor.ts': `
    export function afterCommit(step: () => void, label: string): void { void step; void label }
  `,
  'packages/logger/src/logger.ts': `
    export interface Logger {
      warn(message: string, fields?: Record<string, unknown>): void
      error(message: string): void
    }
    export function createLogger(name: string): Logger {
      void name
      return { warn: () => {}, error: () => {} }
    }
  `,
  'apps/server/src/ports.ts': `
    export interface FeedPort {
      /** Publishes to every connected client. */
      announce(id: number): void
    }
    export interface ClockPort {
      now(): number
    }
    export interface UnjudgedPort {
      mystery(): void
    }
  `,
}

/** Ports the fixtures classify, standing in for `PORT_CAPABILITIES`. */
const FIXTURE_PORTS: Record<string, PortRule> = {
  'apps/server/src/ports.ts#FeedPort.announce': {
    kind: 'observable',
    why: 'publishes to every connected client',
  },
  'apps/server/src/ports.ts#ClockPort.now': { kind: 'contained', why: 'a clock read' },
}

function run(subject: string, extra: Record<string, string> = {}): AnalysisResult {
  const program = createFixtureProgram({
    ...WORLD,
    ...extra,
    'apps/server/src/subject.ts': subject,
  })
  return analyze(program, {
    repoRoot: FIXTURE_ROOT,
    roots: ['apps/server/src/'],
    walk: ['apps/', 'packages/'],
    ports: FIXTURE_PORTS,
  })
}

function observableKeys(result: AnalysisResult): string[] {
  return result.findings.map((finding) => finding.capability.key).sort()
}

/* -------------------------------------------------------------- the rule */

describe('rule 19: observability, not kind', () => {
  it('leaves a diagnostic log inside a span where it is', () => {
    const result = run(`
      import { SessionStore } from './store'
      import { createLogger } from '@podium/logger'
      const log = createLogger('server:store')
      export function quarantine(store: SessionStore, row: string): void {
        store.transact(() => {
          log.warn('a column was corrupt; quarantined', { row })
          store.insert(row)
        })
      }
    `)
    expect(result.roots).toHaveLength(1)
    expect(observableKeys(result)).toEqual([])
  })

  it('flags an effect a caller outside the process can observe', () => {
    const result = run(`
      import { SessionStore } from './store'
      import type { FeedPort } from './ports'
      export function publish(store: SessionStore, feed: FeedPort): void {
        store.transact(() => {
          store.insert('row')
          feed.announce(1)
        })
      }
    `)
    expect(observableKeys(result)).toEqual(['apps/server/src/ports.ts#FeedPort.announce'])
  })

  it('does not flag the same effect once it is registered post-commit', () => {
    const result = run(`
      import { SessionStore } from './store'
      import { afterCommit } from './store/executor/executor'
      import type { FeedPort } from './ports'
      export function publish(store: SessionStore, feed: FeedPort): void {
        store.transact(() => {
          store.insert('row')
          afterCommit(() => feed.announce(1), 'feed')
        })
      }
    `)
    expect(observableKeys(result)).toEqual([])
  })

  it('does not treat a read through a port as an effect', () => {
    const result = run(`
      import { SessionStore } from './store'
      import type { ClockPort } from './ports'
      export function stamp(store: SessionStore, clock: ClockPort): void {
        store.transact(() => store.insert(String(clock.now())))
      }
    `)
    expect(observableKeys(result)).toEqual([])
  })
})

describe('what a name-matching scan cannot do', () => {
  it('follows a call made through a local const (POD-3257)', () => {
    const result = run(`
      import { SessionStore } from './store'
      import type { FeedPort } from './ports'
      export function publish(store: SessionStore, feed: FeedPort): void {
        const announce = feed.announce.bind(feed)
        const tell = (id: number) => { announce(id) }
        store.transact(() => {
          store.insert('row')
          tell(1)
        })
      }
    `)
    expect(observableKeys(result)).toEqual(['apps/server/src/ports.ts#FeedPort.announce'])
  })

  it('follows a call through a closure a helper returns', () => {
    const result = run(`
      import { SessionStore } from './store'
      import type { FeedPort } from './ports'
      function announcer(feed: FeedPort) {
        return (id: number) => { feed.announce(id) }
      }
      export function publish(store: SessionStore, feed: FeedPort): void {
        const tell = announcer(feed)
        store.transact(() => { store.insert('row'); tell(1) })
      }
    `)
    expect(observableKeys(result)).toEqual(['apps/server/src/ports.ts#FeedPort.announce'])
  })

  it('does not flood on Map, array and JSON work', () => {
    const result = run(`
      import { SessionStore } from './store'
      export function compute(store: SessionStore, rows: string[]): void {
        const seen = new Map<string, number>()
        store.transact(() => {
          for (const row of rows) {
            if (!seen.has(row)) seen.set(row, row.length)
            store.insert(JSON.stringify({ row, n: seen.get(row) ?? 0 }))
          }
          rows.map((r) => r.trim()).filter(Boolean).forEach((r) => store.insert(r))
        })
      }
    `)
    expect(observableKeys(result)).toEqual([])
    expect(result.unresolvedCalls).toBe(0)
    // Not merely "not observable": `Map.get` and `Array.map` must not even be
    // CAPABILITIES. Reporting them as unclassified would be the flood in the
    // other register — a to-do list nobody can finish.
    expect([...result.unclassified.keys()]).toEqual([])
  })

  it('reaches an effect several calls deep, across files', () => {
    const result = run(
      `
      import { SessionStore } from './store'
      import type { FeedPort } from './ports'
      import { outer } from './deep'
      export function publish(store: SessionStore, feed: FeedPort): void {
        store.transact(() => outer(feed))
      }
    `,
      {
        'apps/server/src/deep.ts': `
          import type { FeedPort } from './ports'
          function inner(feed: FeedPort): void { feed.announce(2) }
          export function outer(feed: FeedPort): void { inner(feed) }
        `,
      },
    )
    expect(observableKeys(result)).toEqual(['apps/server/src/ports.ts#FeedPort.announce'])
    // The path is the evidence a reader acts on, so it must name every hop.
    expect(result.findings[0]?.path.map((site) => site.file)).toContain('apps/server/src/deep.ts')
  })
})

describe('what the rule refuses to guess', () => {
  it('reports a port member nobody has classified rather than passing it', () => {
    const result = run(`
      import { SessionStore } from './store'
      import type { UnjudgedPort } from './ports'
      export function go(store: SessionStore, port: UnjudgedPort): void {
        store.transact(() => { store.insert('row'); port.mystery() })
      }
    `)
    expect([...result.unclassified.keys()]).toEqual([
      'apps/server/src/ports.ts#UnjudgedPort.mystery',
    ])
    expect(judge(result, []).failures.join('\n')).toContain('UNCLASSIFIED port member')
  })

  it('counts a span body handed in as a value instead of ignoring it', () => {
    const result = run(`
      import { SessionStore } from './store'
      export function forward(store: SessionStore, job: () => void): void {
        store.transact(job)
      }
    `)
    expect(result.roots).toHaveLength(0)
    expect(result.opaqueRoots).toHaveLength(1)
    expect(result.opaqueRoots[0]?.forwarded).toBe(true)
  })

  it('names an unresolvable call instead of treating it as absent', () => {
    const result = run(`
      import { SessionStore } from './store'
      interface AnyPorts { feed: any }
      export function go(store: SessionStore, ports: AnyPorts): void {
        store.transact(() => { store.insert('row'); ports.feed.announce(1) })
      }
    `)
    expect(result.unresolvedCalls).toBeGreaterThan(0)
    expect(result.blindSpots.map((entry) => entry.file)).toContain('apps/server/src/subject.ts')
  })
})

describe('the tables cannot rot quietly', () => {
  it('fails when a declared opener resolves to nothing', () => {
    const openers: OpenerSpec[] = [
      ...SPAN_OPENERS,
      {
        file: 'apps/server/src/store.ts',
        symbol: 'transactRenamed',
        body: 'arg0',
        label: 'a renamed opener',
      },
    ]
    const program = createFixtureProgram({
      ...WORLD,
      'apps/server/src/subject.ts': `
        import { SessionStore } from './store'
        export function go(store: SessionStore): void { store.transact(() => store.insert('r')) }
      `,
    })
    const result = analyze(program, {
      repoRoot: FIXTURE_ROOT,
      roots: ['apps/server/src/'],
      walk: ['apps/', 'packages/'],
      openers,
      ports: FIXTURE_PORTS,
    })
    expect(judge(result, []).failures.join('\n')).toContain('DEAD span opener')
  })

  it('fails on a transaction opener neither table names', () => {
    const result = run(
      `
        import { SessionStore } from './store'
        export function go(store: SessionStore): void { store.transact(() => store.insert('r')) }
      `,
      {
        'apps/server/src/second-store.ts': `
          export interface OtherStore { transact<T>(fn: () => T): T }
        `,
      },
    )
    const failures = judge(result, []).failures.join('\n')
    expect(failures).toContain('UNNAMED transaction opener')
    expect(failures).toContain('apps/server/src/second-store.ts')
  })

  it('fails on slack: an accepted finding nothing matches any more', () => {
    const result = run(`
      import { SessionStore } from './store'
      export function go(store: SessionStore): void { store.transact(() => store.insert('r')) }
    `)
    const verdict = judge(result, [{ key: 'gone@apps/server/src/subject.ts:1', why: 'stale' }])
    expect(verdict.failures.join('\n')).toContain('SLACK in the accepted list')
  })

  it('accepts a listed finding and fails a fresh one', () => {
    const result = run(`
      import { SessionStore } from './store'
      import type { FeedPort } from './ports'
      export function publish(store: SessionStore, feed: FeedPort): void {
        store.transact(() => { store.insert('row'); feed.announce(1) })
      }
    `)
    const key = keyOf(result.findings[0] as (typeof result.findings)[number])
    expect(judge(result, []).failures.join('\n')).toContain('NEW observable effect inside a span')
    // The fixture world holds one opener out of the real table's twelve, so the
    // other eleven are legitimately dead here; the claim is about the effect.
    const withLedger = judge(result, [{ key, why: 'known' }])
    expect(withLedger.failures.filter((f) => !f.startsWith('DEAD span opener'))).toEqual([])
    expect(withLedger.accepted).toHaveLength(1)
  })
})

/*
 * The two shapes that made this gate report FEWER spans than it claimed, both
 * found at the V5 flip's tip [POD-3518]. Neither is a name the tables got
 * wrong: in both, a declaration a call site resolves to stopped being the
 * declaration the table names, and nothing but these two checks says so.
 */
describe('a declaration a call resolves to is not always the one you can see', () => {
  /**
   * `readonly createOrJoinTransaction: TransactionRunner` — the production
   * shape of both store-query ports.
   *
   * The call site's resolved signature is the ALIAS's function type, so the
   * opener row must be keyed on the alias. Keyed on the property, it matches
   * nothing: the openings are not scanned AND the row reports as DEAD, which is
   * the pair of symptoms the tip had.
   */
  const ALIASED_PORT: Record<string, string> = {
    'apps/server/src/queries.ts': `
      export type TransactionRunner = <T>(fn: () => T) => T
      export type SomethingElse = <T>(fn: () => T) => T
      export interface StoreQueries {
        readonly createOrJoinTransaction: TransactionRunner
        /** Same SHAPE, same alias form, and no opener row names it. */
        readonly transaction: SomethingElse
      }
    `,
  }
  const SUBJECT = `
    import type { StoreQueries } from './queries'
    import type { FeedPort } from './ports'
    export function go(queries: StoreQueries, feed: FeedPort): void {
      queries.createOrJoinTransaction(() => { feed.announce(1) })
    }
  `

  function analyzeWith(symbol: string): AnalysisResult {
    const program = createFixtureProgram({
      ...WORLD,
      ...ALIASED_PORT,
      'apps/server/src/subject.ts': SUBJECT,
    })
    return analyze(program, {
      repoRoot: FIXTURE_ROOT,
      roots: ['apps/server/src/'],
      walk: ['apps/', 'packages/'],
      openers: [
        { file: 'apps/server/src/queries.ts', symbol, body: 'arg0', label: 'StoreQueries.open' },
      ],
      ports: FIXTURE_PORTS,
    })
  }

  it('opens a span through a function-typed property keyed by its type alias', () => {
    const result = analyzeWith('TransactionRunner')
    expect(result.roots.map((root) => root.opener)).toEqual(['StoreQueries.open'])
    expect(observableKeys(result)).toEqual(['apps/server/src/ports.ts#FeedPort.announce'])
    expect(result.deadOpeners).toEqual([])
  })

  it('does not report the property that HOLDS a named opener as unnamed', () => {
    // The fixture world's own `SessionStore.transact` is legitimately uncovered
    // here — this arm names one opener — so the claim is about the property,
    // named by file, and not about the count.
    const queriesSites = (result: AnalysisResult): string[] =>
      result.uncoveredOpeners
        .filter((site) => site.file === 'apps/server/src/queries.ts')
        .map((site) => `${site.file}:${site.line}`)
    const sites = queriesSites(analyzeWith('TransactionRunner'))
    // :5 is `createOrJoinTransaction: TransactionRunner`, whose alias IS the
    // named opener.
    expect(sites).not.toContain('apps/server/src/queries.ts:5')
    // :7 is `transaction: SomethingElse` — the same shape, an alias no opener
    // row names — and it IS reported. So this is resolution and not a blanket
    // silence on alias-typed properties. (The discrimination for :5 itself is
    // by mutation: deleting the `openerKeysBehind` clause from
    // findUncoveredOpeners makes :5 appear too. Verified.)
    expect(sites).toContain('apps/server/src/queries.ts:7')
  })

  it('keyed on the property instead, the openings vanish and the row reads dead', () => {
    // The control arm, and it is the tip's own behavior: the same world, the
    // same call, one word different in the table.
    const result = analyzeWith('createOrJoinTransaction')
    expect(result.roots).toEqual([])
    expect(result.deadOpeners).toEqual(['apps/server/src/queries.ts#createOrJoinTransaction'])
  })

  /**
   * `async repoIdResolver(): Promise<(path: string) => RepoId>` — what the flip
   * did to two resolvers, and the reason their PORT_CAPABILITIES rows went
   * stale in silence: a port table has no slack check, so a key that stops
   * being produced is never reported.
   */
  it('names a resolver an async method hands back for the method, not <anonymous>', () => {
    const result = run(
      `
        import { SessionStore } from './store'
        import type { Resolvers } from './resolvers'
        export async function go(store: SessionStore, resolvers: Resolvers): Promise<void> {
          const resolve = await resolvers.make()
          store.transact(() => { store.insert(String(resolve('x'))) })
        }
      `,
      {
        'apps/server/src/resolvers.ts': `
          export interface Resolvers {
            make(): Promise<(key: string) => number>
          }
        `,
      },
    )
    expect([...result.unclassified.keys()]).toEqual([
      'apps/server/src/resolvers.ts#Resolvers.make()',
    ])
  })
})

describe('the production tables', () => {
  it('classifies every port member with a reason, not just a kind', () => {
    for (const [key, rule] of Object.entries(PORT_CAPABILITIES)) {
      expect(rule.why, key).not.toBe('')
      expect(key, `${key} must be keyed by declaration file`).toContain('#')
    }
  })

  it('gives every accepted finding a reason', () => {
    for (const entry of ACCEPTED) {
      expect(entry.why.length, entry.key).toBeGreaterThan(40)
      expect(entry.key, entry.key).toContain('@')
    }
  })
})
