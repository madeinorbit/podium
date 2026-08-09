import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizedWireTests } from '../vitest.unit.config'
import {
  AGGREGATE_INPUTS,
  computePlan,
  diffAgainstPlan,
  LANE_INPUTS,
  readManifest,
  repositoryRoot,
  SHARDS,
  shardTaskName,
  TURBO_CONFIG_PATH,
  turboPackageConfig,
  unitLaneTestFiles,
  verify,
} from './server-test-shards'

/**
 * The drift guard for POD-520's @podium/server shard split.
 *
 * A shard is a cache key, and the only way a cache key hurts is by being WRONG in the
 * narrow direction: declaring fewer inputs than its tests consume, so an edit to that
 * source replays nothing and the lane reports a green nobody earned. Every assertion here
 * is aimed at that, not at tidiness.
 *
 * This lives in @podium/scripts on purpose: that task's Turbo inputs are `apps/**` and
 * `packages/**`, so it re-derives on any source change in the repository. A guard that
 * could itself be served from cache while the graph moved underneath it would be no guard.
 */
/** Every file under apps/server, package-relative — the granularity shard inputs use. */
const walkServerFiles = (dir = join(repositoryRoot, 'apps/server'), out: string[] = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkServerFiles(path, out)
    else out.push(relative(join(repositoryRoot, 'apps/server'), path))
  }
  return out
}

describe('server test cache shards', () => {
  const manifest = readManifest(repositoryRoot)

  it('partitions every unit-lane server test file exactly once', () => {
    // The exhaustiveness refusal. `bun run test` reaches apps/server ONLY through the five
    // shards now, so a file that no shard claims is a file that silently stopped running —
    // the failure mode this split could most easily introduce and the hardest to notice.
    expect(verify(repositoryRoot)).toEqual([])

    const claimed = manifest.shards.flatMap((shard) => shard.testFiles)
    expect(new Set(claimed).size, 'a test file is claimed by two shards').toBe(claimed.length)
    expect([...claimed].sort()).toEqual(unitLaneTestFiles(repositoryRoot))
  })

  it('still declares every input its tests actually consume', () => {
    // Re-derives the import closure from disk and compares it against what the manifest
    // and apps/server/turbo.json declare. Membership moving (an added import) or inputs
    // shrinking (a deleted glob) both land here.
    expect(diffAgainstPlan(repositoryRoot)).toEqual([])
  })

  it('keeps apps/server/turbo.json identical to the derivation', () => {
    const onDisk = JSON.parse(readFileSync(join(repositoryRoot, TURBO_CONFIG_PATH), 'utf8'))
    expect(onDisk).toEqual(turboPackageConfig(computePlan(repositoryRoot)))
  })

  it('routes the whole lane through the aggregate so test:affected sees every shard', () => {
    // `scripts/test-affected.ts` reads the `test` task graph from `turbo run test --dry=json`
    // and refuses on any changed file no test-capable package owns. The shards are only in
    // that graph because `test` depends on them; drop one here and its files leave both the
    // default lane and the affected lane at once, with nothing turning red.
    // Read what Turbo reads, not what the generator would produce — the test above already
    // pins those to each other, and this one has to be about the file in effect.
    const { tasks } = JSON.parse(readFileSync(join(repositoryRoot, TURBO_CONFIG_PATH), 'utf8')) as {
      tasks: Record<string, { dependsOn: string[]; inputs: string[] }>
    }
    expect(tasks.test?.dependsOn).toEqual(SHARDS.map((shard) => shardTaskName(shard.id)))
    expect(tasks.test?.inputs).toEqual([...AGGREGATE_INPUTS])
    for (const shard of SHARDS) expect(tasks[shardTaskName(shard.id)]).toBeDefined()
  })

  it('gives every shard the migration tree, which POD-523 made a lane-level input', () => {
    // Most shards import nothing under src/migrations. They depend on it anyway:
    // test-pre-migrated-schema.ts hashes the migration manifest to build the schema image
    // every store in every shard clones. A migration edit therefore changes what all five
    // shards run against, and a shard that dropped this glob would serve a stale green
    // against the old schema — the most expensive false green available here.
    for (const shard of manifest.shards) {
      expect(shard.inputs, `${shard.id} lost the migration tree`).toContain('src/migrations/**')
      for (const laneInput of LANE_INPUTS) expect(shard.inputs).toContain(laneInput)
    }
  })

  it('leaves no server source file unhashed by every shard', () => {
    // The complement of the exhaustiveness refusal above. That one asks "does every test
    // file run?"; this asks "can any server file change without a single shard noticing?".
    // A file matched by no shard's globs is one whose edits are invisible to the whole
    // lane — the split's worst failure mode, and the one that looks exactly like success.
    const globs = manifest.shards.map((shard) => ({
      id: shard.id,
      matchers: shard.inputs
        .filter((input) => !input.startsWith('$TURBO_ROOT$'))
        .map((input) => new Bun.Glob(input)),
    }))
    const serverFiles = walkServerFiles().filter((file) => /\.tsx?$/.test(file))
    expect(serverFiles.length).toBeGreaterThan(600)
    const unhashed = serverFiles.filter(
      (file) => !globs.some((shard) => shard.matchers.some((glob) => glob.match(file))),
    )
    expect(unhashed, 'these apps/server files are in no shard cache key').toEqual([])
  })

  it('declares the inputs no import graph can see', () => {
    // Regression test for the class the old single key handled by hand: oracle-tags.test.ts
    // READS the client-core oracle with readFileSync, and the two cutover audits SPAWN
    // their scripts as subprocesses. None of the three is an import, so a purely
    // import-derived key would drop them and cache straight past a change to any of them.
    const boundary = manifest.shards.find((shard) => shard.id === 'boundary')
    expect(boundary?.inputs).toEqual(
      expect.arrayContaining([
        '$TURBO_ROOT$/packages/client-core/src/**',
        '$TURBO_ROOT$/scripts/audit-automation-commands.ts',
        '$TURBO_ROOT$/scripts/audit-workflow-commands.ts',
      ]),
    )
    // The broad shard owns every source-scanning audit, so it declares the server tree
    // whole — a scanner that walks a directory at runtime depends on files nothing can name.
    expect(boundary?.inputs).toContain('src/**')
  })

  it('still replays the whole server suite when sync source changes [POD-515 feedback loop]', () => {
    // Asserted as the CONCLUSION, not as "a glob is missing", because whoever sees this red
    // will be mid-narrowing and needs to be told what they are about to break rather than
    // which line to re-add.
    //
    // A sync-system rewrite is in flight and relies on a sync-source edit replaying the
    // server suite. The split does not narrow that — sync is in all five keys, exactly as
    // the single key had it. Changing that is a decision to make with the rewrite's owner,
    // not a side effect of regenerating this manifest.
    const blind = manifest.shards.filter(
      (shard) => !shard.inputs.includes('$TURBO_ROOT$/packages/sync/src/**'),
    )
    const covered = manifest.shards
      .filter((shard) => !blind.includes(shard))
      .reduce((count, shard) => count + shard.testFiles.length, 0)
    const total = manifest.shards.reduce((count, shard) => count + shard.testFiles.length, 0)
    expect(
      blind.map((shard) => shard.id),
      `a change to packages/sync would no longer replay the whole @podium/server suite: ` +
        `${covered}/${total} test files would run, and ${blind.map((s) => s.id).join(', ')} ` +
        'would be served from cache. A sync-system rewrite depends on that feedback loop. ' +
        'This constraint comes from the POD-515 test-gate review, which is where it was ' +
        'written down — NOT who owns the rewrite. Before narrowing it, find whoever owns ' +
        'the sync-system rewrite and agree it with them.',
    ).toEqual([])
    expect(covered).toBe(total)
  })

  it('keeps the normalized-wire guards in the default gate as their own unit', () => {
    // POD-515 Keep item 5. Sharding these means an independent cache key — never moving
    // them out of `bun run test` and never relaxing them.
    const wire = manifest.shards.find((shard) => shard.id === 'normalized-wire')
    expect([...(wire?.testFiles ?? [])].sort()).toEqual([...normalizedWireTests].sort())
  })

  it('gives every shard a package script', () => {
    const pkg = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps/server/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    // The aggregate runs the exhaustiveness refusal rather than a suite; the shards do the
    // work and Turbo reaches them through `dependsOn`.
    expect(pkg.scripts.test).toContain(
      'validation-admission.ts focused --label @podium/server:test',
    )
    expect(pkg.scripts.test).toContain('bun ../../scripts/server-test-shards.ts')
    for (const shard of SHARDS) {
      expect(pkg.scripts[shardTaskName(shard.id)], `no script for shard ${shard.id}`).toContain(
        `vitest.mjs run --config vitest.${shard.id}.config.ts`,
      )
    }
  })
})
