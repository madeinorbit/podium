/**
 * THE RUNTIME ARM of the superagent-surface audit (POD-383).
 *
 * `scripts/audit-superagent-commands.ts` reads source TEXT and resolves no
 * modules. This reads the RUNNING system: the real `appRouter` object, actually
 * assembled at import time, and its actual procedure map. Neither instrument is
 * sufficient alone, and the pairing is the point — POD-732's standard is that
 * "an empty router satisfies every absence claim perfectly", so:
 *
 *  · the source arm can be fooled by a file nothing imports;
 *  · this arm can be fooled by a router that was never assembled.
 *
 * So this file asserts the POSITIVE first, on the same object: `sendTurn` IS
 * served, as a MUTATION, and there are exactly seven superagent writes. An
 * `appRouter` that failed to assemble, or a table that lost its entries, fails
 * those before it can pass "and `send` is gone".
 */

import { describe, expect, it } from 'vitest'
import { appRouter } from '../../router'
import { SUPERAGENT_COMMANDS, isSuperagentProcExposedOn } from './registry'

/** The assembled procedure map, keyed by dotted path — what tRPC dispatches on. */
const procedures = (): Record<string, { _def?: { type?: string } }> =>
  (appRouter as unknown as { _def: { procedures: Record<string, { _def?: { type?: string } }> } })
    ._def.procedures

const superagentPaths = (): string[] =>
  Object.keys(procedures())
    .filter((p) => p.startsWith('superagent.'))
    .sort()

const typeOf = (path: string): string | undefined => procedures()[path]?._def?.type

describe('the assembled superagent router', () => {
  /**
   * THE POSITIVE, FIRST. Without it the absence assertion below would be
   * satisfied by a router that serves nothing at all.
   */
  it('serves every contract in the table, as a mutation', () => {
    for (const name of Object.keys(SUPERAGENT_COMMANDS)) {
      expect([name, typeOf(`superagent.${name}`)]).toEqual([name, 'mutation'])
    }
    expect(Object.keys(SUPERAGENT_COMMANDS)).toHaveLength(7)
  })

  it('serves the two reads as QUERIES — a write cannot hide among them', () => {
    expect(typeOf('superagent.listThreads')).toBe('query')
    expect(typeOf('superagent.history')).toBe('query')
  })

  /**
   * THE DEDUPE, ON THE RUNNING OBJECT. The wire name `superagent.send` is not
   * served — asserted against the same map that just proved `sendTurn` IS, so
   * this cannot pass by the router being empty.
   */
  it('does not serve the deleted `send` alias', () => {
    expect(superagentPaths()).not.toContain('superagent.send')
    expect(superagentPaths()).toContain('superagent.sendTurn')
    // Nothing else crept onto the router either: the nine paths are the seven
    // derived writes plus the two hand-written reads, and no tenth.
    expect(superagentPaths()).toEqual([
      'superagent.clear',
      'superagent.concierge',
      'superagent.history',
      'superagent.interruptTurn',
      'superagent.listThreads',
      'superagent.openInTerminal',
      'superagent.restart',
      'superagent.sendTurn',
      'superagent.startBtw',
    ])
  })

  /**
   * ADR 3 D3 default-closed, shown BOTH ways. The `false` arm is the one that
   * matters and it is the one a lazy predicate gets wrong: an unknown proc must
   * be refused, not assumed fine.
   */
  it('answers exposure default-closed for an unknown proc', () => {
    expect(isSuperagentProcExposedOn('sendTurn', 'trpc')).toBe(true)
    expect(isSuperagentProcExposedOn('send', 'trpc')).toBe(false)
    expect(isSuperagentProcExposedOn('sendTurn', 'cli')).toBe(false)
  })

  /**
   * The derivation refuses to build a procedure whose contract does not declare
   * `trpc` — at MODULE LOAD, not at call time, because a procedure that refuses
   * every request looks identical to one nobody happened to call. Shown firing
   * on a contract with its exposure emptied, so the check is known to be live
   * rather than assumed from the code being present.
   */
  it('refuses to derive a procedure whose contract does not declare trpc', async () => {
    const { SUPERAGENT_COMMANDS: table } = await import('./registry')
    const entry = table.sendTurn
    const original = entry.contract.exposure
    Object.defineProperty(entry.contract, 'exposure', { value: [], configurable: true })
    try {
      const { superagentFamilyProcedures } = await import('./trpc')
      expect(() => superagentFamilyProcedures()).toThrow(/does not declare the trpc transport/)
    } finally {
      Object.defineProperty(entry.contract, 'exposure', {
        value: original,
        configurable: true,
      })
    }
    // …and it builds again once the declaration is back, so the throw above was
    // about the exposure and not about the builder being broken.
    const { superagentFamilyProcedures } = await import('./trpc')
    expect(Object.keys(superagentFamilyProcedures())).toHaveLength(7)
  })
})
