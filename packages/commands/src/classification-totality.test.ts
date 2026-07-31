/**
 * THE POPULATION GATE — every command contract in the fleet is classified, and
 * the population is derived from the FILESYSTEM rather than from a list anyone
 * maintains (POD-315, ADR 3 D3 rule 1's "compile- and test-enforced totality";
 * ADR 3 Amendment 1 compliance checklist).
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ALREADY TRUE, AND WHY IT WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * `classificationErrors` is thorough and `CommandContractBase.visibility` is a
 * REQUIRED field, so an individual contract cannot be half-classified. The hole
 * was never in the check — it was in WHICH CONTRACTS GET CHECKED.
 *
 * Before this file the totality claim rested on sixteen independent
 * `registryClassificationErrors(...)` calls, one per server registry module,
 * each covering the contracts that module happens to import. Measured on the
 * branch point: 16 of 18 registries made that call, and
 * `apps/server/src/modules/{issues,lock,perf}/registry.ts` made none. So the
 * seventeenth registry, and every contract no registry imports, were outside
 * every instrument — and nothing anywhere would have said so.
 *
 * That is this run's dominant defect class arriving at the classification lint:
 * MECHANISM PRESENCE IS NOT COVERAGE. A rule enforced per file is a rule the
 * next file does not have — the same reasoning `framework-facet-rules.test.ts`
 * gives for scanning `defineCommands` tables package-wide instead of asserting
 * per table. This file is that argument applied to the OTHER contract family,
 * the `CommandContract` one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILESYSTEM AND NOT `./index`
 * ---------------------------------------------------------------------------
 *
 * Discovering contracts through the package's public exports would inherit the
 * exact failure it exists to catch: a contracts module that is written, imported
 * by a registry, and never re-exported from `index.ts` would be invisible to the
 * scan while being perfectly live in the product. `import.meta.glob` reads the
 * directory, so the population is what EXISTS rather than what was remembered.
 *
 * ---------------------------------------------------------------------------
 * A SCAN THAT FINDS NOTHING PASSES EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * Every assertion below is a loop over discovered contracts, so a discovery that
 * silently stopped matching would turn the file green and mean nothing. The
 * first describe is therefore the instrument check, and it is load-bearing:
 * it asserts the scan found contracts from EVERY module that has any, by module
 * path. "No classification errors" may only be read after "and it looked at
 * these 200-odd contracts, from these 20-odd files".
 */

import { describe, expect, it } from 'vitest'
import { commandVisibility, type CommandDef } from './framework'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
} from './contract'

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every source module in this package, read off disk.
 *
 * TEST FILES ARE EXCLUDED IN THE PATTERN, NOT DOWNSTREAM, and the difference is
 * not cosmetic. Filtering them out of the RESULTS still eagerly imports them,
 * which executes their `describe`/`it` registrations inside this file: the first
 * run of this suite reported **419 tests** for a file declaring about a dozen,
 * because it had absorbed every other suite in the package. A gate that silently
 * re-runs its neighbours is measuring something other than what it claims, and
 * the inflated green is exactly the kind of number nobody questions.
 *
 * The second reason is the original one: several suites build a deliberately
 * broken fixture contract to prove `classificationErrors` fires, and a fixture
 * authored to be invalid is not part of the fleet's population.
 */
const MODULES = import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], { eager: true }) as Record<
  string,
  Record<string, unknown>
>

/** Structural recognition — a contract is what has the required fields, not what
 *  is named `*Contract`. Naming is a convention; this is the type's shape. */
function isContract(value: unknown): value is AnyCommandContract {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Partial<AnyCommandContract>
  return (
    typeof c.name === 'string' &&
    typeof c.version === 'number' &&
    typeof c.visibility === 'string' &&
    Array.isArray(c.exposure) &&
    typeof c.policy === 'object' &&
    c.policy !== null &&
    typeof c.delivery === 'object' &&
    c.delivery !== null &&
    typeof c.redaction === 'object' &&
    c.redaction !== null &&
    c.input !== undefined
  )
}

interface Found {
  readonly module: string
  readonly contract: AnyCommandContract
}

/** Contracts reachable from a module: exported directly, or as values of an
 *  exported table (`FLEET_CONTRACTS` and friends). One level of nesting is all
 *  the package uses, and going deeper would start matching unrelated records. */
function contractsIn(module: Record<string, unknown>): AnyCommandContract[] {
  const out: AnyCommandContract[] = []
  for (const value of Object.values(module)) {
    if (isContract(value)) {
      out.push(value)
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (isContract(nested)) out.push(nested)
    }
  }
  return out
}

const FOUND: Found[] = Object.entries(MODULES).flatMap(([path, module]) =>
  contractsIn(module).map((contract) => ({ module: path, contract })),
)

/** The same contract is re-exported from `index.ts` and from its own module, so
 *  the population is deduped BY IDENTITY — two distinct objects sharing a name
 *  are a real duplicate and must survive to be reported as one. */
const POPULATION: AnyCommandContract[] = [...new Set(FOUND.map((f) => f.contract))]

/** Modules that contribute at least one contract, excluding the barrel. */
const CONTRACT_MODULES = [
  ...new Set(FOUND.filter((f) => f.module !== './index.ts').map((f) => f.module)),
].sort()

describe('the contract scan itself', () => {
  it('discovers contracts from the filesystem, and names the modules it read', () => {
    // Named explicitly so a discovery that quietly stopped seeing a whole family
    // fails here rather than passing everything downstream. These are the
    // families whose absence would be least noticeable: the four `sessions/*`
    // files that are NOT called `contracts.ts`, and the mail table that carries
    // the human-ceiling rules.
    expect(CONTRACT_MODULES).toEqual(
      expect.arrayContaining([
        './mail/contracts.ts',
        './fleet/contracts.ts',
        './issues/contracts.ts',
        './settings/contracts.ts',
        './sessions/rename.ts',
        './sessions/handoff.ts',
      ]),
    )
  })

  it('imports no test file — the exclusion is in the pattern, and this is what says so', () => {
    // The live guard that replaced a downstream `.filter`. A filter would have
    // kept the results clean while still executing every neighbouring suite
    // inside this one; only the module list can show that they were not loaded.
    expect(Object.keys(MODULES).filter((path) => path.includes('.test.'))).toEqual([])
  })

  it('every contracts-bearing source file on disk contributes to the population', () => {
    // THE NON-VACUITY FLOOR, derived rather than chosen. Every `*/contracts.ts`
    // that exists must have been read: a new family that lands without being
    // exported — or a glob that stops matching a directory — fails here, which is
    // the failure mode a hand-written module list cannot have because the list
    // would simply not mention it.
    const onDisk = Object.keys(MODULES)
      .filter((path) => path.endsWith('/contracts.ts'))
      .sort()
    expect(onDisk.length).toBeGreaterThan(0)
    for (const path of onDisk) {
      expect(CONTRACT_MODULES, `${path} contributed no contracts`).toContain(path)
    }
  })

  it('the population is large, and the floor is derived from the modules read', () => {
    // Not a round number picked by hand: every contracts module carries at least
    // one command, so the floor moves with the directory. A glob that matched one
    // file and reported success cannot satisfy this.
    expect(POPULATION.length).toBeGreaterThanOrEqual(CONTRACT_MODULES.length)
    expect(POPULATION.length).toBeGreaterThanOrEqual(50)
  })

  it('the scan discriminates — it does not sweep up every exported object', () => {
    // Structural recognition is specific, but "every object export" would not be,
    // and a scan matching everything would report violations from unrelated
    // shapes rather than covering contracts. Every member must be a dotted wire
    // name, which no schema, constant or helper record is.
    for (const contract of POPULATION) {
      expect(contract.name, JSON.stringify(contract.name)).toMatch(/^[a-z][\w-]*(\.[\w-]+)+$/i)
    }
  })
})

describe('classification is TOTAL over the whole population (ADR 3 D3 rule 1)', () => {
  it('every contract in the package carries policy, exposure, delivery, redaction and a visibility class', () => {
    // The one call that makes the sixteen per-registry calls belt-and-braces
    // rather than the load-bearing claim. A registry that forgets its own check
    // — or never had one, as issues/lock/perf do not — no longer takes its
    // contracts outside every instrument.
    expect(registryClassificationErrors(POPULATION)).toEqual([])
  })

  it('names are unique across the WHOLE fleet, not merely within each table', () => {
    // `registryClassificationErrors` checks this too, but only over the array it
    // is handed — which is precisely the per-registry scope that let two tables
    // claim one wire name. Asserted here over the union, where it can be true.
    const names = POPULATION.map((c) => c.name)
    expect([...new Set(names)].sort()).toEqual([...names].sort())
  })

  /**
   * THE INSTRUMENT MUST BE ABLE TO SAY NO. Three suites in this package already
   * prove `classificationErrors` fires on a broken fixture; what has never been
   * proven is that it fires on a contract reached BY THIS SCAN — i.e. that the
   * population above is actually being checked rather than being an empty array
   * dressed up as a census.
   */
  it('a violation planted in a REAL discovered contract is caught', () => {
    const real = POPULATION[0]
    expect(real).toBeDefined()
    const broken: AnyCommandContract = {
      ...real,
      redaction: { ...real.redaction, reviewed: false },
    }
    const errs = registryClassificationErrors([...POPULATION.slice(1), broken])
    expect(errs).toEqual([`${real.name}: redaction must be explicitly reviewed`])
  })
})

describe('an undeclared visibility class resolves to PRIVATE (ADR 9 D4)', () => {
  /**
   * `CommandContractBase.visibility` is required, so on the `CommandContract`
   * family "undeclared" is a compile error and there is no runtime default to
   * test. The `CommandDef` family is where a default can still be reached, and
   * `commandVisibility` is the total function that reaches it — this pins the
   * DIRECTION of that default, which is the half §3.1.1 rule 1 cares about:
   * forgetting to classify must fail toward privacy, never toward exposure.
   */
  it('a CommandDef with no declared class is personal, not tenant-visible', () => {
    const unclassified = {} as CommandDef
    expect(commandVisibility(unclassified)).toBe('personal')
  })

  it('and a declared class is still honoured — the default is a default, not an override', () => {
    // Without this the assertion above would also pass against a function that
    // returned 'personal' unconditionally, which would be default-closed and
    // useless in the same breath.
    const substrate = { visibility: 'deployment-substrate' } as unknown as CommandDef
    expect(commandVisibility(substrate)).toBe('deployment-substrate')
  })
})

describe('the per-contract lint keeps its teeth on the population’s own shapes', () => {
  it('every contract exposed on `outbox` really is offline-eligible (D3 rule 2)', () => {
    // Stated positively over the population rather than trusting the aggregate
    // above, because this is the rule whose violation is a queued write with a
    // delayed fuse.
    for (const c of POPULATION.filter((c) => c.exposure.includes('outbox'))) {
      expect(c.delivery.class, c.name).toBe('offline-eligible')
    }
  })

  it('no contract in the fleet is served nowhere by accident', () => {
    // ADR 3 D3 makes empty exposure MEAN "served nowhere", which is the correct
    // default — but a contract that reaches no transport at all is dead weight
    // the registry still validates. Report them by name rather than failing:
    // deliberate no-exposure contracts are legitimate (a reserved name, a
    // contract awaiting its router), and this asserts only that we know which.
    const nowhere = POPULATION.filter((c) => c.exposure.length === 0).map((c) => c.name)
    expect(nowhere).toEqual([])
  })

  it('classificationErrors is applied per contract, not only in aggregate', () => {
    for (const c of POPULATION) expect(classificationErrors(c), c.name).toEqual([])
  })
})
