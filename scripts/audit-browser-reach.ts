#!/usr/bin/env bun
/**
 * audit-browser-reach — the RUNNING-BUNDLER half of the guard on
 * `packages/sync`'s `neutral` tag (POD-307).
 *
 * `packages/sync` is tagged neutral rather than node-only because half of it is
 * the browser's and the phone's replica storage (ADR 6 D1). That tag is only
 * honest while the declared browser entrypoints stay Node-free, and ONE
 * instrument is not enough to say so:
 *
 *   SOURCE TEXT — rule 12b in scripts/check-boundaries.ts. Walks the import
 *     closure by reading files. Sees every relative and workspace edge, and sees
 *     them without needing anything installed. BLIND to npm: it checks bare
 *     specifiers against a short explicit list and cannot follow `some-lib` into
 *     whatever that library imports.
 *
 *   THIS FILE — a real browser-target bundler resolving real modules through the
 *     real `exports` maps, with a plugin that reports every `node:`/`bun:`
 *     specifier it is asked to resolve AND which module asked for it. Sees the
 *     whole npm graph. BLIND when nothing is installed, and blind to a module
 *     that is tree-shaken out today and reachable after one edit.
 *
 * Each is blind where the other sees, which is why both ship. Neither is allowed
 * to be the only thing that can say no.
 *
 * THE FAILURE THIS EXISTS TO CATCH, and the reason the check is not "did the
 * bundle build": `bun build --target=browser` does NOT fail on `node:fs`. It
 * silently substitutes an empty object —
 *
 *     var {readFileSync} = (() => ({}));
 *
 * — so the build succeeds, the exit code is 0, the emitted bundle contains no
 * `node:` string to grep for, and the client explodes at runtime instead. An
 * audit written as "bundle it and check the exit code" would be green against
 * exactly the defect it was written for. The plugin is what makes the refusal
 * possible at all.
 *
 * NON-VACUITY IS CHECKED, not assumed. A bundler that resolved nothing would
 * report zero Node references for every entrypoint and pass perfectly — the
 * "empty router satisfies every absence claim" shape (POD-732). So each
 * entrypoint must emit a non-empty bundle and load at least as many modules as
 * its own source NAMES (see {@link expectedModuleFloor}), and `--probe` proves
 * both arms can fail:
 *
 *     bun scripts/audit-browser-reach.ts            # the gate
 *     bun scripts/audit-browser-reach.ts --probe    # plant fixtures that MUST fail it
 *
 * The entrypoint list is imported from scripts/check-boundaries.ts rather than
 * restated here: two copies of a declaration list is how one of them goes stale
 * while both stay green.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYNC_BROWSER_ENTRYPOINTS } from './check-boundaries'

export interface ReachFinding {
  entrypoint: string
  kind: 'node-reference' | 'build-failed' | 'vacuous'
  detail: string
}

/**
 * The non-vacuity floor, MEASURED from the entrypoint rather than guessed at.
 *
 * A fixed floor was the first version and it was wrong: `@podium/sync/span` is a
 * single self-contained module with no imports at all, so "at least two modules"
 * failed a file that is correct. A floor that a correct tree cannot meet gets
 * lowered until it means nothing.
 *
 * So the floor is the entrypoint's own count of distinct relative imports, plus
 * itself. A barrel's `export * from './x'` targets are part of the module's
 * public surface and survive bundling, so this is exactly the number a healthy
 * resolution produces — and one short of it means the bundler silently failed to
 * follow an edge, which is the vacuous pass the check exists for.
 */
export function expectedModuleFloor(entrySource: string): number {
  const relatives = new Set<string>()
  for (const m of entrySource.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]*)['"]/g,
  )) {
    if (m[1]) relatives.add(m[1])
  }
  return 1 + relatives.size
}

/**
 * Bundle one entrypoint for the browser and report every Node/Bun specifier the
 * bundler was asked to resolve, with the module that asked.
 */
export async function auditEntrypoint(
  label: string,
  absEntry: string,
): Promise<ReachFinding[]> {
  const findings: ReachFinding[] = []
  const nodeRefs: string[] = []
  let loaded = 0
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build({
      entrypoints: [absEntry],
      target: 'browser',
      plugins: [
        {
          name: 'podium-no-node',
          setup(build) {
            // Marking them external rather than throwing keeps the build going,
            // so ONE run reports every leak instead of the first one.
            build.onResolve({ filter: /^(?:node:|bun:)/ }, (args) => {
              nodeRefs.push(`${args.path} (imported by ${args.importer})`)
              return { path: args.path, external: true }
            })
            build.onLoad({ filter: /\.tsx?$/ }, () => {
              loaded += 1
              return undefined
            })
          },
        },
      ],
    })
  } catch (err) {
    return [
      {
        entrypoint: label,
        kind: 'build-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
    ]
  }
  for (const ref of nodeRefs) {
    findings.push({
      entrypoint: label,
      kind: 'node-reference',
      detail: `resolves ${ref} — a browser bundle would inline Node code, and bun's browser target substitutes an EMPTY OBJECT rather than failing, so this reaches the client as a runtime crash`,
    })
  }
  if (!result.success) {
    for (const log of result.logs) {
      findings.push({ entrypoint: label, kind: 'build-failed', detail: String(log.message ?? log) })
    }
  }
  const bytes = result.outputs[0] ? (await result.outputs[0].text()).length : 0
  const floor = expectedModuleFloor(readFileSync(absEntry, 'utf8'))
  if (loaded < floor || bytes === 0) {
    findings.push({
      entrypoint: label,
      kind: 'vacuous',
      detail: `loaded ${loaded} module(s) and emitted ${bytes} byte(s) — the entrypoint names ${floor - 1} relative module(s), so a healthy resolution loads ${floor}. A bundler that resolves nothing reports no Node references for any input, so this run would prove nothing about browser safety`,
    })
  }
  return findings
}

/** Audit every declared browser entrypoint of @podium/sync. */
export async function auditDeclaredEntrypoints(repoRoot: string): Promise<ReachFinding[]> {
  const findings: ReachFinding[] = []
  for (const [specifier, entry] of SYNC_BROWSER_ENTRYPOINTS) {
    findings.push(...(await auditEntrypoint(specifier, join(repoRoot, entry))))
  }
  return findings
}

// ---------------------------------------------------------------------------
// --probe — planted fixtures that MUST fail the gate
// ---------------------------------------------------------------------------

interface ProbeCase {
  name: string
  files: Record<string, string>
  entry: string
  expect: ReachFinding['kind']
}

const PROBE_CASES: readonly ProbeCase[] = [
  {
    name: 'a Node builtin three hops from the entrypoint',
    files: {
      'entry.ts': `export * from './a'\n`,
      'a.ts': `export * from './b'\n`,
      'b.ts': `export * from './c'\n`,
      'c.ts': `import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    },
    entry: 'entry.ts',
    expect: 'node-reference',
  },
  {
    name: 'a Bun builtin behind an npm-shaped indirection',
    files: {
      'entry.ts': `export * from './lib'\n`,
      'lib.ts': `import { Database } from 'bun:sqlite'\nexport const x = Database\n`,
    },
    entry: 'entry.ts',
    expect: 'node-reference',
  },
  {
    // The condition the vacuity check needs is "the bundler did not follow an
    // edge the source names". A type-only re-export produces it honestly: rule
    // 12b's source-text walker sees `./t` and walks it; the bundler erases the
    // whole statement and never loads the file. That divergence is the blind
    // spot this instrument would otherwise hide behind, so it is the fixture.
    name: 'an edge the source names that the bundler never loads',
    files: { 'entry.ts': `export type * from './t'\n`, 't.ts': `export type T = string\n` },
    entry: 'entry.ts',
    expect: 'vacuous',
  },
]

async function runProbe(): Promise<number> {
  let failures = 0
  for (const probe of PROBE_CASES) {
    const dir = mkdtempSync(join(tmpdir(), 'browser-reach-probe-'))
    try {
      for (const [rel, source] of Object.entries(probe.files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), source)
      }
      const findings = await auditEntrypoint(`probe:${probe.name}`, join(dir, probe.entry))
      const caught = findings.some((f) => f.kind === probe.expect)
      console.log(`${caught ? 'PASS' : 'FAIL'}  ${probe.name} — expected a '${probe.expect}'`)
      if (!caught) {
        failures += 1
        for (const f of findings) console.log(`        got: [${f.kind}] ${f.detail}`)
        if (findings.length === 0) console.log('        got: nothing at all')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // The other half of the probe: the gate must also say YES. A probe that only
  // shows refusals is satisfied by a check that refuses everything.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const real = await auditDeclaredEntrypoints(repoRoot)
  const clean = real.length === 0
  console.log(
    `${clean ? 'PASS' : 'FAIL'}  the real declared entrypoints are clean — the gate can say YES`,
  )
  if (!clean) {
    failures += 1
    for (const f of real) console.log(`        [${f.kind}] ${f.entrypoint}: ${f.detail}`)
  }
  console.log(
    failures === 0
      ? `\nprobe OK — ${PROBE_CASES.length} planted fixture(s) failed the gate as required, and the real tree passes it`
      : `\nprobe FAILED — ${failures} check(s) could not say what they must be able to say`,
  )
  return failures === 0 ? 0 : 1
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--probe')) {
    process.exit(await runProbe())
  }
  const findings = await auditDeclaredEntrypoints(repoRoot)
  if (findings.length > 0) {
    console.error(`\nbrowser-reach violations (${findings.length}):\n`)
    for (const f of findings) console.error(`  [${f.kind}] ${f.entrypoint}: ${f.detail}`)
    console.error(
      '\n@podium/sync is tagged NEUTRAL on the strength of these closures staying Node-free',
    )
    console.error('(scripts/architecture-manifest.ts). Fix the dependency or drop the entrypoint.')
    process.exit(1)
  }
  console.log(
    `browser-reach OK — ${SYNC_BROWSER_ENTRYPOINTS.size} declared entrypoint(s) bundle for the browser with no Node reachable`,
  )
}

if (import.meta.main) await main()
