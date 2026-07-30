/**
 * THE DERIVED SPEC tRPC SURFACE, AGAINST THE RUNNING ROUTER (POD-386).
 *
 * `scripts/audit-spec-commands.ts` is the source-TEXT half of this gate: it
 * resolves no modules, runs in a fresh checkout, and can see a hand-written
 * `.mutation(` growing back in `router.ts`. It cannot see whether anything is
 * actually served — a `...specFamily` spread of an empty object satisfies every
 * claim it makes.
 *
 * This is the other half. It reads the built `appRouter`'s dispatch table, and
 * it drives a derived procedure's own handler through a REAL `SpecsService` over
 * a REAL temp repo. No Proxy, no fake service: POD-732's finding was a CLI suite
 * "green against a server serving nothing", and the fix is that the thing under
 * test has to be able to refuse.
 *
 * WHAT THE REFUSING ARM DEPENDS ON. Nothing environmental for the dispatch-table
 * assertions — `appRouter` is built at module load from the definition the server
 * serves. For the dispatch test the one setup fact is a real directory on disk,
 * and the test creates it; the refusal path is exercised too (an unregistered
 * root must be FORBIDDEN), so the gate is not satisfiable by a service that
 * accepts everything.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPEC_CONTRACT_NAMES, SPEC_CONTRACTS } from '@podium/commands'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it } from 'vitest'
import { appRouter } from '../../router'
import { isSpecCommandExposedOn, SPEC_COMMANDS_TRPC, specCommandsOn } from './registry'
import { SpecsService, specsInputs } from './service'

type ProcedureDef = { _def?: { type?: string } }
const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })
  ._def.procedures
const typeOf = (name: string): string | undefined => procedures[name]?._def?.type

let dirs: string[] = []
function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'podium-spec-trpc-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('the specs router serves what the contracts declare', () => {
  it('serves every `trpc`-exposed contract as a MUTATION', () => {
    const exposed = specCommandsOn('trpc')
    // Non-vacuity first: an empty exposure list would make the loop below pass
    // without asserting anything, which is the shape POD-732 named.
    expect(exposed).toEqual(['create', 'remove', 'save'])
    for (const name of exposed) {
      expect(typeOf(`specs.${name}`), `specs.${name} is not served`).toBe('mutation')
    }
  })

  it('serves the three reads as QUERIES, so a write cannot hide among them', () => {
    for (const name of ['list', 'get', 'search']) {
      expect(typeOf(`specs.${name}`)).toBe('query')
    }
  })

  it('serves NOTHING on `specs.` that no contract and no read accounts for', () => {
    const served = Object.keys(procedures)
      .filter((n) => n.startsWith('specs.'))
      .map((n) => n.slice('specs.'.length))
      .sort()
    expect(served).toEqual([...SPEC_CONTRACT_NAMES, 'get', 'list', 'search'].sort())
  })

  it('the dispatch table is real — the accessor can say NO', () => {
    expect(Object.keys(procedures).length).toBeGreaterThan(50)
    expect(typeOf('specs.nonexistent')).toBeUndefined()
  })
})

describe('the derived procedures dispatch to the real service', () => {
  it('runs create → save → remove through a real repo, via the TABLE’s handlers', async () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })

    const created = (await SPEC_COMMANDS_TRPC.create.handler(svc, {
      repoPath: repo,
      title: 'Derived',
      parent: 'SP-root',
    })) as { id: string; title: string }
    expect(created.title).toBe('Derived')

    const saved = (await SPEC_COMMANDS_TRPC.save.handler(svc, {
      repoPath: repo,
      id: created.id,
      title: 'Renamed',
    })) as { title: string }
    expect(saved.title).toBe('Renamed')

    expect(svc.get({ repoPath: repo, id: created.id })).not.toBeNull()
    await SPEC_COMMANDS_TRPC.remove.handler(svc, { repoPath: repo, id: created.id })
    expect(svc.get({ repoPath: repo, id: created.id })).toBeNull()
  })

  it('REFUSES a root the machine does not register — the gate did not move', () => {
    const svc = new SpecsService({ repoRoots: () => [tmpRepo()] })
    // Synchronous, deliberately: `SpecsService.create` throws before it returns,
    // so a `.rejects` assertion would never see the error and would pass against
    // a service that never refused. The refusal is not on a promise.
    const unregistered = tmpRepo() // a real directory, but not a REGISTERED one
    expect(() =>
      SPEC_COMMANDS_TRPC.create.handler(svc, {
        repoPath: unregistered,
        title: 'Nope',
        parent: 'SP-root',
      }),
    ).toThrow(TRPCError)
    expect(() =>
      SPEC_COMMANDS_TRPC.remove.handler(svc, { repoPath: unregistered, id: 'SP-0001' }),
    ).toThrow(/not a known repository path/)
  })
})

describe('one schema instance serves every transport', () => {
  it('the contract, the service table and the built procedure share the SAME object', () => {
    // `toBe`, not `toEqual`, and PER ARM: a restated schema with identical fields
    // is byte-identical on the wire and passes every golden fixture in the repo.
    // Only identity sees the fork (POD-305).
    expect(specsInputs.create).toBe(SPEC_CONTRACTS.create.input)
    expect(specsInputs.save).toBe(SPEC_CONTRACTS.save.input)
    expect(specsInputs.remove).toBe(SPEC_CONTRACTS.remove.input)
    expect(SPEC_COMMANDS_TRPC.create.contract.input).toBe(SPEC_CONTRACTS.create.input)
    expect(SPEC_COMMANDS_TRPC.save.contract.input).toBe(SPEC_CONTRACTS.save.input)
    expect(SPEC_COMMANDS_TRPC.remove.contract.input).toBe(SPEC_CONTRACTS.remove.input)
  })

  it('and the identity assertion can say NO', () => {
    // A restatement of `specsCreateInput` — same fields, different object. If this
    // passed `toBe`, the assertions above would be measuring nothing.
    const restated = SPEC_CONTRACTS.create.input.and(SPEC_CONTRACTS.create.input)
    expect(restated).not.toBe(SPEC_CONTRACTS.create.input)
  })
})

describe('exposure is default-closed and checked both ways', () => {
  it('an unknown command name is NOT exposed — a typo removes a surface, never opens one', () => {
    expect(isSpecCommandExposedOn('nonexistent', 'trpc')).toBe(false)
  })

  it('the exposure reader can say YES, so its NOs mean something', () => {
    expect(isSpecCommandExposedOn('create', 'trpc')).toBe(true)
    expect(isSpecCommandExposedOn('create', 'cli')).toBe(true)
    // `mcp` is absent ON PURPOSE — POD-385 measured that no MCP provider derives
    // a spec tool, unlike the issue family where CLI and MCP are one table.
    expect(isSpecCommandExposedOn('create', 'mcp')).toBe(false)
  })
})
