/**
 * THE DEFERRED-CAPABILITY GATE (A3/PDM-129) — a v1 scope decision, enforced
 * against the contract table instead of remembered.
 *
 * The population is discovered the way `classification-totality.test.ts`
 * discovers its own, and for the same reason: reading the package's public
 * exports would miss a contracts module that is written and imported by a
 * registry but never re-exported, which is invisible to the scan while being
 * perfectly live in the product.
 *
 * Test files are excluded IN THE PATTERN rather than downstream — filtering them
 * out of the results still imports them, which executes their registrations
 * inside this file. Several suites build deliberately broken fixture contracts,
 * and a fixture authored to be invalid is not part of the fleet's population.
 */

import { describe, expect, it } from 'vitest'
import { type AnyCommandContract } from './contract'
import { DEFERRED_CAPABILITIES, DEFERRED_COMMAND_NAMES, isDeferredCapability } from './deferred'

/**
 * `import.meta.glob` is Vite's, and this package does not pull in `vite/client`'s
 * ambient types, so the capability is declared locally. It MUST be called by its
 * full literal name: aliasing it through a typed cast type-checks and then fails
 * at RUN time, because the transform is syntactic and never sees the alias.
 */
declare global {
  interface ImportMeta {
    glob(
      patterns: readonly string[],
      options: { eager: true },
    ): Record<string, Record<string, unknown>>
  }
}

const MODULES = import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], { eager: true })

function discoveredContracts(): Array<{ module: string; contract: AnyCommandContract }> {
  const found: Array<{ module: string; contract: AnyCommandContract }> = []
  for (const [path, module] of Object.entries(MODULES)) {
    for (const value of Object.values(module)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        typeof (value as { name: unknown }).name === 'string' &&
        'exposure' in value &&
        Array.isArray((value as { exposure: unknown }).exposure) &&
        'policy' in value
      ) {
        found.push({ module: path, contract: value as AnyCommandContract })
      }
    }
  }
  return found
}

describe('the contract scan found the fleet', () => {
  it('discovers contracts from many modules', () => {
    const contracts = discoveredContracts()
    // The instrument check. Every assertion below loops over this population, so
    // a discovery that silently stopped matching would turn the file green and
    // mean nothing. "No deferred capability is served" may only be read after
    // "and it looked at this many contracts, from this many files".
    expect(contracts.length).toBeGreaterThan(100)
    expect(new Set(contracts.map((entry) => entry.module)).size).toBeGreaterThan(10)
  })

  it('finds the machine-sharing contracts it is meant to be guarding', () => {
    // Named explicitly: these are the two the census found ALREADY served, so a
    // scan that no longer sees them is a scan that would pass vacuously on the
    // one case this gate was written for.
    const names = discoveredContracts().map((entry) => entry.contract.name)
    expect(names).toContain('machines.share')
    expect(names).toContain('machines.unshare')
  })
})

describe('no deferred capability is reachable on any transport', () => {
  it('serves no deferred command anywhere', () => {
    const served = discoveredContracts()
      .filter((entry) => isDeferredCapability(entry.contract.name))
      .filter((entry) => entry.contract.exposure.length > 0)
      .map((entry) => `${entry.contract.name} (${entry.module}) → ${entry.contract.exposure.join(', ')}`)
    // Default-closed for a scope decision: a deferred capability that declares
    // ANY transport is reachable, and which transport it is does not soften it.
    expect(served).toEqual([])
  })

  it('does not refuse task sharing, which v1 keeps', () => {
    // The guard against over-reach. `issues.share` is the existing owner-or-grant
    // task model the charter KEEPS; a fuzzy `*.share` rule would have caught it,
    // and the fix for that would have been an exception list — which is how a
    // scope gate becomes something people route around.
    expect(isDeferredCapability('issues.share')).toBe(false)
    expect(isDeferredCapability('issues.unshare')).toBe(false)
  })
})

describe('the deferred list is auditable', () => {
  it('cites a charter clause for every capability', () => {
    for (const entry of DEFERRED_CAPABILITIES) {
      expect(entry.commandNames.length).toBeGreaterThan(0)
      // A deferral nobody can trace to a decision is a deferral that gets
      // reversed by whoever finds it inconvenient.
      expect(entry.charterClause.length).toBeGreaterThan(30)
    }
  })

  it('names each command exactly once', () => {
    expect(new Set(DEFERRED_COMMAND_NAMES).size).toBe(DEFERRED_COMMAND_NAMES.length)
  })
})
