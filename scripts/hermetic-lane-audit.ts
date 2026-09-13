/**
 * THE HERMETIC-LANE CENSUS.
 *
 * One question, asked of every vitest lane this repository can start: can it resolve
 * the operator's live `~/.podium`?
 *
 * WHY A WALK AND NOT A LIST. `scripts/test-configuration.test.ts` already asserts
 * hermetic `setupFiles` — but it asks the question of a HAND-WRITTEN import roster, so
 * a config that is merely absent from that roster is never asked at all, and a config
 * that is present is only asked about the properties someone thought to assert. On
 * this branch both failure modes were live at once:
 *
 *   - `apps/web/vitest.tuck-fanout-probe.config.ts` is in no roster anywhere, and
 *     shipped with ZERO setupFiles.
 *   - `apps/web/vitest.frontend-perf.config.ts` also shipped with ZERO setupFiles, and
 *     IS imported by that test (line 26) — which asserts its `include`, `retry`,
 *     `fileParallelism` and `maxWorkers`, and never its hermeticity. The audit looked
 *     straight at the violation and did not see it.
 *
 * An audit with that failure mode is worse than no audit, because it is cited as
 * coverage. A filesystem walk cannot have it: a new config file is in the roster the
 * moment it exists, whether or not anyone remembers this file.
 *
 * SCOPE, STATED RATHER THAN IMPLIED. This audits the two runners the hermetic setup
 * actually owns: vitest lanes (via `setupFiles`) and `bun test` (via bunfig's
 * `[test].preload`). It deliberately does NOT judge the Playwright configs under
 * `tests/e2e/`. Their isolation is real but is established elsewhere — `harness-env.ts`
 * assigns PODIUM_STATE_DIR when `serve-harness.ts` boots the webServer — so a
 * config-shape rule cannot see it, and a rule that demanded a `globalSetup` would
 * report three findings nobody could act on. That gap is covered instead by the other
 * half of this change: `refuseLiveStateDir` in the resolver, which does not care which
 * runner is running.
 *
 * Pure functions here, assertions in the sibling `.test.ts`, so the detector can be run
 * against a PLANTED fixture as well as against the real tree — which is how it proves
 * it can still fail.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** The two setup files that, together, make a vitest lane hermetic. */
export const HERMETIC_SETUP_FILES = [
  'test-hermetic-env.ts',
  'test-hermetic-vitest-hooks.ts',
] as const

/** The bun preload pair; `bun test` gets its isolation here rather than from vitest. */
export const HERMETIC_BUN_PRELOADS = ['test-hermetic-env.ts', 'test-hermetic-bun-hooks.ts'] as const

const PRUNED = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-bun',
  '.turbo',
  'target',
  'coverage',
  '.artifacts',
  '.worktrees',
  '.claude',
])

export interface Finding {
  /** Repo-relative config path. */
  config: string
  /** Vitest project name, or '(root)' for a single-project config. */
  project: string
  reason: string
}

/**
 * Every `vitest*.config.*` in the tree. A PRUNING walk, so a nested checkout, a build
 * output directory or a sibling worktree cannot inflate the roster — and so the count
 * assertion in the sibling test means something.
 */
export function discoverVitestConfigs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (PRUNED.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^vitest.*\.config\.[cm]?ts$/.test(entry.name)) found.push(path)
    }
  }
  walk(root)
  return found.sort()
}

type LoadedConfig = Record<string, unknown>

/**
 * The projects a config actually runs. A config with no `projects` is one project; a
 * STRING entry is a reference to another config file, which the walk audits in its own
 * right and which must not be double-counted (or, worse, reported here under a name
 * that does not tell you which file to open).
 */
function projectsOf(config: LoadedConfig): { project: string; test: LoadedConfig }[] {
  const test = (config?.test ?? {}) as LoadedConfig
  const projects = test.projects
  if (!Array.isArray(projects) || projects.length === 0) return [{ project: '(root)', test }]
  return projects.flatMap((entry: unknown, index: number) => {
    if (typeof entry === 'string') return []
    const projectTest = ((entry as LoadedConfig)?.test ?? {}) as LoadedConfig
    return [{ project: (projectTest.name as string) ?? `#${index}`, test: projectTest }]
  })
}

/**
 * Findings for one already-loaded vitest config.
 *
 * `setupFiles` are resolved the way VITEST resolves them: against `config.root` when
 * the config sets one, else against the config file's own directory. That distinction
 * is not a detail — `createPackageVitestConfig` sets `root: repositoryRoot` precisely
 * so the shared relative `'./test-hermetic-env.ts'` lands, and a rule that resolved
 * against the config's own directory would report every one of those package lanes as
 * broken. Twenty-odd false positives is how an audit gets switched off.
 */
export function auditVitestConfig(
  repoRoot: string,
  configPath: string,
  config: LoadedConfig,
): Finding[] {
  const name = relative(repoRoot, configPath)
  const base = config?.root ? resolve(config.root as string) : resolve(configPath, '..')
  const findings: Finding[] = []
  for (const { project, test } of projectsOf(config)) {
    const declared = test?.setupFiles ?? (config?.test as LoadedConfig)?.setupFiles ?? []
    const resolved = (Array.isArray(declared) ? declared : [declared])
      .filter((file): file is string => typeof file === 'string')
      .map((file) => resolve(base, file))
    for (const required of HERMETIC_SETUP_FILES) {
      if (
        !resolved.some((file) => file === join(base, required) || file.endsWith(`/${required}`))
      ) {
        findings.push({
          config: name,
          project,
          reason: `setupFiles does not include ${required} — this lane resolves ~/.podium`,
        })
      }
    }
    for (const file of resolved) {
      try {
        statSync(file)
      } catch {
        findings.push({
          config: name,
          project,
          reason: `setupFiles entry does not exist: ${relative(repoRoot, file)} — a relative entry resolved against the wrong root names a file nobody loads, and the lane runs unprotected`,
        })
      }
    }
  }
  return findings
}

/** `bun test` gets its isolation from bunfig's preload, which vitest never reads. */
export function auditBunfig(repoRoot: string, source: string): Finding[] {
  return HERMETIC_BUN_PRELOADS.filter((preload) => !source.includes(preload)).map((preload) => ({
    config: relative(repoRoot, join(repoRoot, 'bunfig.toml')),
    project: '(bun test)',
    reason: `[test].preload does not load ${preload} — every \`bun test\` file resolves ~/.podium`,
  }))
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map((finding) => `  ${finding.config} [${finding.project}]: ${finding.reason}`)
    .join('\n')
}

export function readFile(path: string): string {
  return readFileSync(path, 'utf8')
}
