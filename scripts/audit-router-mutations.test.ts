/**
 * The router `.mutation(` census, in a LANE (POD-386).
 *
 * The census is only worth its ratchet if the PARSER is right, so most of what
 * follows is about the parser rather than the checks. The bug it is guarding
 * against is real and was live in this file's first draft: an
 * indentation-anchored reader names the last field of an inline `z.object({…})`
 * as the procedure, so `conversations.setMeta` was recorded as
 * `conversations.summary` — and the both-directions check then fired on four
 * routers nobody had touched.
 *
 * As with every gate in this run, each check is asserted in BOTH directions: it
 * must find what it hunts, and it must stay quiet on a clean fixture. A census
 * whose checks cannot say YES would certify any router.ts at all.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  auditRouterMutations,
  parseCensus,
  parseRouterBlocks,
  pendingDrift,
  ratchet,
  stripCommentsAndStrings,
  uncensusedRouters,
  writesInMigratedRouters,
} from './audit-router-mutations'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('the census, against the live tree', () => {
  it('is clean', () => {
    expect(
      auditRouterMutations(
        read('apps/server/src/router.ts'),
        read('scripts/router-mutation-census.json'),
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe('the parser names PROCEDURES, not schema fields', () => {
  it('does not mistake the last field of an inline input schema for the procedure', () => {
    const blocks = parseRouterBlocks(
      [
        'export const appRouter = t.router({',
        '  conversations: t.router({',
        '    setMeta: t.procedure',
        '      .input(z.object({ id: z.string(), summary: z.string().optional() }))',
        '      .mutation(({ ctx, input }) => ctx.set(input)),',
        '  }),',
        '})',
      ].join('\n'),
    )
    expect(blocks[0]?.keys).toEqual(['setMeta'])
  })

  it('reads a write inside a NESTED router, and one written after that router closes', () => {
    const blocks = parseRouterBlocks(
      [
        'export const appRouter = t.router({',
        '  alpha: t.router({',
        '    nested: t.router({',
        '      deep: t.procedure.mutation(() => 1),',
        '    }),',
        '    after: t.procedure.mutation(() => 2),',
        '  }),',
        '})',
      ].join('\n'),
    )
    expect(blocks[0]?.keys).toEqual(['deep', 'after'])
  })

  it('counts neither a `.mutation(` in a comment nor one in a string literal', () => {
    const blocks = parseRouterBlocks(
      [
        'export const appRouter = t.router({',
        '  beta: t.router({',
        '    // there is deliberately no .mutation( for a beta anywhere in this file',
        "    list: t.procedure.query(() => 'not a .mutation( either'),",
        '  }),',
        '})',
      ].join('\n'),
    )
    expect(blocks[0]?.keys).toEqual([])
  })

  it('keeps line numbers truthful while blanking comments and strings', () => {
    const source = [
      'const a = 1',
      '/* two',
      '   lines */',
      "const b = '. . .'",
      'const c = 3',
    ].join('\n')
    const stripped = stripCommentsAndStrings(source)
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length)
    expect(stripped).toHaveLength(source.length)
    expect(stripped.split('\n')[4]).toBe('const c = 3')
  })

  it('reads every top-level router and only top-level routers', () => {
    const blocks = parseRouterBlocks(read('apps/server/src/router.ts'))
    // Sanity anchors from the live file: the derived families and a pending one.
    const names = blocks.map((b) => b.name)
    expect(names).toContain('specs')
    expect(names).toContain('settings')
    expect(blocks.find((b) => b.name === 'specs')?.keys).toEqual([])
    // `set` alone since POD-1080 contracted the telegram binding ceremony; the
    // parser still has a NON-EMPTY anchor here, which is the point of reading a
    // pending router at all (a parser finding nothing passes every claim).
    expect(blocks.find((b) => b.name === 'settings')?.keys).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The checks — both directions
// ---------------------------------------------------------------------------

const FIXTURE = parseRouterBlocks(
  [
    'export const appRouter = t.router({',
    '  derived: t.router({',
    '    ...family,',
    '  }),',
    '  pending: t.router({',
    '    write: t.procedure.mutation(() => 1),',
    '  }),',
    '})',
  ].join('\n'),
)

const censusOf = (o: unknown): ReturnType<typeof parseCensus> => parseCensus(JSON.stringify(o))

const CLEAN = censusOf({
  total: 1,
  migrated: { routers: ['derived'], allowed: {} },
  pending: { pending: { owner: 'POD-314', keys: ['write'] } },
})

describe('census membership', () => {
  it('finds a router in neither list — what the per-family audits cannot see', () => {
    const findings = uncensusedRouters(
      FIXTURE,
      censusOf({ total: 1, migrated: { routers: ['derived'] }, pending: {} }),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['census-membership'])
    expect(findings[0]?.detail).toContain('`pending` router is in neither')
  })

  it('finds a census that has ROTTED — a name with no router behind it', () => {
    const findings = uncensusedRouters(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived', 'ghost'] },
        pending: { pending: { keys: ['write'] } },
      }),
      '<fixture>',
    )
    expect(findings[0]?.detail).toContain('ghost')
  })

  it('finds a router counted twice', () => {
    const findings = uncensusedRouters(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived', 'pending'] },
        pending: { pending: { keys: ['write'] } },
      }),
      '<fixture>',
    )
    expect(findings[0]?.detail).toContain('BOTH migrated and pending')
  })

  it('stays quiet on a fully censused router set', () => {
    expect(uncensusedRouters(FIXTURE, CLEAN, '<fixture>')).toEqual([])
  })
})

describe('a derived family carries no hand-written write', () => {
  it('fires when a migrated router grows one', () => {
    const findings = writesInMigratedRouters(
      FIXTURE,
      censusOf({ total: 1, migrated: { routers: ['derived', 'pending'] }, pending: {} }),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['derived-family-clean'])
  })

  it('forgives an allowlisted key — on ITS OWN router only', () => {
    const forgiven = writesInMigratedRouters(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived', 'pending'], allowed: { pending: ['write'] } },
        pending: {},
      }),
      '<fixture>',
    )
    expect(forgiven).toEqual([])
    const elsewhere = writesInMigratedRouters(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived', 'pending'], allowed: { derived: ['write'] } },
        pending: {},
      }),
      '<fixture>',
    )
    expect(elsewhere).toHaveLength(1)
  })

  it('stays quiet on a clean fixture', () => {
    expect(writesInMigratedRouters(FIXTURE, CLEAN, '<fixture>')).toEqual([])
  })
})

describe('pending drift, in both directions', () => {
  it('finds an ADDED write the census does not list', () => {
    const findings = pendingDrift(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived'] },
        pending: { pending: { keys: [] } },
      }),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['pending-census'])
  })

  it('finds a REMOVED write the census still lists', () => {
    const findings = pendingDrift(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived'] },
        pending: { pending: { keys: ['write', 'gone'] } },
      }),
      '<fixture>',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('POD-1180')
  })

  it('stays quiet when the census matches', () => {
    expect(pendingDrift(FIXTURE, CLEAN, '<fixture>')).toEqual([])
  })
})

describe('the settings guard fails in BOTH directions', () => {
  const guarded = (keys: string[]): ReturnType<typeof parseCensus> =>
    censusOf({
      total: 1,
      migrated: { routers: ['derived'] },
      pending: { pending: { owner: 'POD-352', guard: true, keys } },
    })

  it('fires — as `settings-guard` — when a guarded router LOSES a write', () => {
    const findings = pendingDrift(FIXTURE, guarded(['write', 'absorbed']), '<fixture>')
    expect(findings.map((f) => f.check)).toEqual(['settings-guard'])
    expect(findings[0]?.detail).toContain('not this phase’s to migrate')
  })

  it('fires — as `settings-guard` — when a guarded router GAINS a write', () => {
    const findings = pendingDrift(FIXTURE, guarded([]), '<fixture>')
    expect(findings.map((f) => f.check)).toEqual(['settings-guard'])
  })

  it('reports a guarded router differently from an ordinary pending one', () => {
    const guardedFinding = pendingDrift(FIXTURE, guarded([]), '<fixture>')[0]
    const ordinary = pendingDrift(
      FIXTURE,
      censusOf({
        total: 1,
        migrated: { routers: ['derived'] },
        pending: { pending: { keys: [] } },
      }),
      '<fixture>',
    )[0]
    expect(guardedFinding?.check).not.toBe(ordinary?.check)
  })
})

describe('the ratchet', () => {
  it('fires when the total GROWS', () => {
    expect(ratchet(FIXTURE, censusOf({ total: 0 }))[0]?.detail).toContain('may only go DOWN')
  })

  it('fires when the total SHRINKS without the census being updated', () => {
    expect(ratchet(FIXTURE, censusOf({ total: 5 }))[0]?.detail).toContain('--update-census')
  })

  it('fires when the census declares no total at all', () => {
    expect(ratchet(FIXTURE, censusOf({}))).toHaveLength(1)
  })

  it('stays quiet when the total matches', () => {
    expect(ratchet(FIXTURE, CLEAN)).toEqual([])
  })
})
