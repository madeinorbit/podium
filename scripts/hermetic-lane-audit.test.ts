/**
 * THE DETECTOR, AND THE PROOF THAT IT CAN STILL FAIL.
 *
 * Every census case is a PAIR: plant the violation, then remove it. A `toEqual([])`
 * against a clean tree is satisfied just as well by an audit that has stopped being
 * able to see anything, and a restating assertion catches a removed entry but never an
 * added one. The clean case is the one that matters most, so it is the one that most
 * needs a partner that fails.
 *
 * WHY THE openStoreDatabase CASE IS HERE rather than beside apps/server/src/store-database.ts:
 * that package's lanes are driven by the generated shard manifest in
 * apps/server/test-shards.json, and a new test file there runs in no lane until the
 * manifest is regenerated. Regenerating it is a large, unrelated diff on a release
 * branch. The refusal belongs with the census either way — they are the two halves of
 * one claim: the census says no lane resolves the live tree, and the refusal says that
 * if one ever does, the open still does not happen.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openStoreDatabase } from '../apps/server/src/store-database'
import {
  auditBunfig,
  auditVitestConfig,
  discoverVitestConfigs,
  type Finding,
  formatFindings,
  readFile,
} from './hermetic-lane-audit'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temporary = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hermetic-audit-'))
  scratch.push(dir)
  return dir
}

const hermeticPair = ['./test-hermetic-env.ts', './test-hermetic-vitest-hooks.ts']

describe('the census: every vitest lane in the tree is hermetic', () => {
  it('finds nothing across the whole DERIVED roster', async () => {
    const configs = discoverVitestConfigs(repoRoot)
    // The roster has to be a real one. A walk that pruned its way down to two files
    // would report a clean tree for entirely the wrong reason, and this assertion is
    // the only thing standing between that and a green check.
    expect(configs.length).toBeGreaterThan(30)
    const findings: Finding[] = []
    for (const path of configs) {
      let loaded = (await import(path)).default
      if (typeof loaded === 'function') loaded = await loaded({ command: 'serve', mode: 'test' })
      findings.push(...auditVitestConfig(repoRoot, path, loaded))
    }
    expect(findings, `non-hermetic lanes:\n${formatFindings(findings)}`).toEqual([])
  }, 180_000)

  it('sees a config that is in NO hand-written roster — the reason this is a walk', () => {
    // scripts/test-configuration.test.ts asks its question of an import list. A config
    // absent from that list is never asked; apps/web/vitest.tuck-fanout-probe.config.ts
    // shipped that way. The walk has the file the moment it exists.
    const planted = join(repoRoot, 'packages/model/vitest.nobody-listed-this.config.ts')
    expect(auditVitestConfig(repoRoot, planted, { test: { include: ['x.test.ts'] } })).toHaveLength(
      2,
    )
  })

  it('catches a config that declares no setupFiles at all', () => {
    const findings = auditVitestConfig(repoRoot, join(temporary(), 'vitest.planted.config.ts'), {
      test: { include: ['x.test.ts'] },
    })
    expect(findings.map((finding) => finding.reason)).toEqual([
      expect.stringContaining('test-hermetic-env.ts'),
      expect.stringContaining('test-hermetic-vitest-hooks.ts'),
    ])
  })

  it('catches HALF a hermetic pair', () => {
    // The realistic regression: someone adds a setup file and rewrites the array.
    const findings = auditVitestConfig(repoRoot, join(repoRoot, 'vitest.planted.config.ts'), {
      root: repoRoot,
      test: { setupFiles: ['./test-hermetic-env.ts'] },
    })
    expect(findings).toEqual([
      {
        config: 'vitest.planted.config.ts',
        project: '(root)',
        reason: expect.stringContaining('test-hermetic-vitest-hooks.ts'),
      },
    ])
  })

  it('catches ONE non-hermetic project inside an otherwise hermetic config', () => {
    // The shape a shard split introduces, and the one a whole-config check misses.
    const findings = auditVitestConfig(repoRoot, join(repoRoot, 'vitest.planted.config.ts'), {
      root: repoRoot,
      test: {
        projects: [
          { test: { name: 'good', setupFiles: hermeticPair } },
          { test: { name: 'bad', setupFiles: ['./test-hermetic-env.ts'] } },
        ],
      },
    })
    expect(findings).toEqual([
      {
        config: 'vitest.planted.config.ts',
        project: 'bad',
        reason: expect.stringContaining('test-hermetic-vitest-hooks.ts'),
      },
    ])
  })

  it('catches a setupFiles entry that names a file nobody loads', () => {
    // A relative entry resolved against the wrong root is not an error anywhere — it
    // is simply a lane running with one fewer setup file than its author believes.
    const findings = auditVitestConfig(repoRoot, join(repoRoot, 'vitest.planted.config.ts'), {
      root: repoRoot,
      test: { setupFiles: [...hermeticPair, './does-not-exist.ts'] },
    })
    expect(findings).toEqual([
      {
        config: 'vitest.planted.config.ts',
        project: '(root)',
        reason: expect.stringContaining('does not exist'),
      },
    ])
  })

  it('does NOT fire on relative entries resolved against a package config root', () => {
    // The counterfactual for every case above. The package lanes built by
    // createPackageVitestConfig live in apps/*/ and packages/*/ but set
    // `root: repositoryRoot`, which is what makes the shared relative entries land. An
    // audit that resolved against the config's own directory would report all of them,
    // and would be switched off inside a week.
    expect(
      auditVitestConfig(repoRoot, join(repoRoot, 'packages/model/vitest.config.ts'), {
        root: repoRoot,
        test: { setupFiles: hermeticPair },
      }),
    ).toEqual([])
  })

  it('does not double-count a project that is a REFERENCE to another config file', () => {
    // The root config lists './apps/web/vitest.config.ts' as a project. That file is
    // audited on its own by the walk; reporting it again here would name a project
    // that tells nobody which file to open.
    expect(
      auditVitestConfig(repoRoot, join(repoRoot, 'vitest.planted.config.ts'), {
        root: repoRoot,
        test: { setupFiles: hermeticPair, projects: ['./apps/web/vitest.config.ts'] },
      }),
    ).toEqual([])
  })
})

describe('the runner vitest does not own', () => {
  it('keeps `bun test` on the hermetic preload', () => {
    expect(auditBunfig(repoRoot, readFile(join(repoRoot, 'bunfig.toml')))).toEqual([])
  })

  it('catches a bunfig that dropped the preload, and one that dropped half of it', () => {
    expect(auditBunfig(repoRoot, '[test]\npreload = []\n')).toHaveLength(2)
    expect(auditBunfig(repoRoot, '[test]\npreload = ["./test-hermetic-env.ts"]\n')).toHaveLength(1)
  })
})

describe('the refusal — the half that survives a lane nobody enumerated', () => {
  // NOTHING HERE OPENS A DATABASE. openStoreDatabase throws before it reaches a driver,
  // which is the property being asserted; a regression in this file cannot itself cause
  // the incident it exists to prevent.
  it('refuses to open anything inside the operator live state tree', async () => {
    const liveStateDir = process.env.PODIUM_LIVE_STATE_DIR
    expect(liveStateDir, 'the hermetic setup did not publish the live root').toBeTruthy()
    await expect(openStoreDatabase(join(liveStateDir as string, 'podium.db'))).rejects.toThrow(
      /openStoreDatabase resolved the operator's live state tree/,
    )
  })

  it('still opens an in-memory store and a hermetic path — the counterfactual', async () => {
    // Without this, the refusal above would pass for a guard that refused everything,
    // and no test could open a store at all.
    const memory = await openStoreDatabase(':memory:')
    expect(memory).toBeTruthy()
    memory.close?.()
    const hermetic = join(temporary(), 'store.db')
    const opened = await openStoreDatabase(hermetic)
    expect(opened).toBeTruthy()
    opened.close?.()
  })
})
