/**
 * Affected-only test entry point (POD-1688). `bun run test:affected` lands here.
 *
 * Runs `turbo run test` filtered to the packages a change actually touches —
 * `--filter='...[<base>]'` selects packages whose own sources changed plus every
 * package that depends on them. In a 22-package workspace that is the difference
 * between "re-run everything" and "re-run the blast radius".
 *
 * Three things this file exists to get right:
 *
 *   1. THE BASE REF IS RESOLVED, NOT HARDCODED. Agents work in worktrees off
 *      long-lived branches, so a fixed `origin/main` picks the wrong fork point.
 *      We take the merge base against the closest of {explicit override, upstream,
 *      origin/main, long-lived project branches} — see resolveBase().
 *
 *   2. IT REFUSES TO REPORT A GREEN IT DID NOT EARN. A package filter cannot scope
 *      the root-level lanes (test:unit / test:integration / test:acceptance), which
 *      sweep the whole monorepo from root vitest configs. Any changed file that no
 *      `test`-capable package owns is therefore INVISIBLE to this lane, and that is
 *      a hard error (exit 1), not a warning — under-running tests and printing green
 *      is the one failure this lane must never produce. Override with
 *      --allow-uncovered once you have run the full lane yourself.
 *
 *   3. A BROKEN INSTALL IS A MISS, NOT A HIT. Reuses the environment fingerprint from
 *      scripts/typecheck.ts (PODIUM_CHECK_ENV_HASH, declared in turbo.json globalEnv)
 *      so a dangling node_modules/@podium can't serve a stale cached green (POD-1343).
 *
 * This lane is a fast approximation for the inner loop. It does NOT replace
 * `bun run test` before a commit. See AGENTS.md "Affected-only tests".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprint, readCensus } from './typecheck'

/** Runs a git command, returning trimmed stdout, or null if git exited non-zero. */
export type Git = (args: string[]) => string | null

export interface BaseDecision {
  /** The commit to diff against — a resolved sha, never a symbolic ref. */
  base: string
  /** Human-readable account of how we got there, printed on every run. */
  how: string
}

/**
 * Long-lived branches a worktree may legitimately have been cut from. Anything
 * else (another agent's issue branch) must never become a base: it would move the
 * fork point forward and silently drop packages out of the run.
 */
export function longLivedCandidates(git: Git): string[] {
  const out = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
  if (!out) return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((ref) => ref === 'origin/main' || ref.startsWith('origin/project/'))
}

/**
 * Pick the fork point. Among candidate merge bases we take the one CLOSEST to HEAD
 * (the one every other candidate is an ancestor of): that is the branch this work
 * actually diverged from, so everything before it belongs to someone else.
 */
export function resolveBase(
  git: Git,
  opts: { explicit?: string | null } = {},
): BaseDecision | { error: string } {
  if (opts.explicit) {
    const sha = git(['rev-parse', '--verify', `${opts.explicit}^{commit}`])
    if (!sha) return { error: `base ref "${opts.explicit}" does not resolve to a commit` }
    return { base: sha, how: `explicit base "${opts.explicit}"` }
  }

  const refs: string[] = []
  const upstream = git(['rev-parse', '--abbrev-ref', '@{upstream}'])
  if (upstream) refs.push(upstream)
  for (const ref of longLivedCandidates(git)) if (!refs.includes(ref)) refs.push(ref)

  const bases: { ref: string; sha: string }[] = []
  for (const ref of refs) {
    const sha = git(['merge-base', 'HEAD', ref])
    if (sha) bases.push({ ref, sha })
  }
  if (bases.length === 0) {
    return {
      error:
        'could not resolve a base commit: no upstream, no origin/main, no origin/project/* ' +
        'branch shares history with HEAD. Pass one explicitly:\n' +
        '  bun run test:affected -- --base=<ref>',
    }
  }

  // Closest-to-HEAD wins: keep the candidate that every other candidate is an ancestor of.
  let best = bases[0] as { ref: string; sha: string }
  for (const cand of bases.slice(1)) {
    if (git(['merge-base', '--is-ancestor', best.sha, cand.sha]) !== null) best = cand
  }
  const others = bases.filter((b) => b.sha !== best.sha).map((b) => b.ref)
  return {
    base: best.sha,
    how:
      `merge base with ${best.ref} (${best.sha.slice(0, 9)})` +
      (others.length ? `; closer than ${others.join(', ')}` : ''),
  }
}

/** Every file that differs from the base, including uncommitted and untracked work. */
export function changedFiles(git: Git, base: string): string[] {
  const seen = new Set<string>()
  for (const args of [
    ['diff', '--name-only', `${base}...HEAD`],
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const line of (git(args) ?? '').split('\n')) {
      const f = line.trim()
      if (f) seen.add(f)
    }
  }
  return [...seen].sort()
}

export interface PackageDir {
  /** Workspace-relative directory, e.g. "packages/model". */
  dir: string
  name: string
  /** Does it define a `test` script — i.e. can turbo's `test` task cover it at all? */
  hasTest: boolean
}

/** Reads the workspace globs from the root package.json and resolves them on disk. */
export function readPackages(root: string): PackageDir[] {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const out: PackageDir[] = []
  for (const glob of (rootPkg.workspaces ?? []) as string[]) {
    const dirs = glob.endsWith('/*')
      ? (() => {
          const parent = glob.slice(0, -2)
          if (!existsSync(join(root, parent))) return []
          return readdirSync(join(root, parent)).map((d) => `${parent}/${d}`)
        })()
      : [glob]
    for (const dir of dirs) {
      const manifest = join(root, dir, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      out.push({ dir, name: pkg.name, hasTest: Boolean(pkg.scripts?.test) })
    }
  }
  return out.sort((a, b) => b.dir.length - a.dir.length) // longest prefix first
}

export interface Coverage {
  /** Changed files that the `test` task graph can never see. */
  uncovered: string[]
  /** Why each one is invisible, for the escalation message. */
  reasons: Map<string, string>
}

/**
 * A changed file is covered only if it lives in a package that defines a `test`
 * script. Root configs, tooling, and packages whose suites live in the root-level
 * lanes are all INVISIBLE to `turbo run test` — those are exactly the cases where a
 * green from this lane would be a lie.
 */
export function assessCoverage(files: string[], packages: PackageDir[]): Coverage {
  const uncovered: string[] = []
  const reasons = new Map<string, string>()
  for (const file of files) {
    const owner = packages.find((p) => file === p.dir || file.startsWith(`${p.dir}/`))
    if (!owner) {
      uncovered.push(file)
      reasons.set(file, 'no workspace package owns it (root-level lane territory)')
    } else if (!owner.hasTest) {
      uncovered.push(file)
      reasons.set(file, `${owner.name} defines no \`test\` script`)
    }
  }
  return { uncovered, reasons }
}

/** Lanes this entry point structurally cannot scope. Printed on every single run. */
export const NOT_COVERED = [
  'test:unit         — root vitest sweep over the whole monorepo',
  'test:integration  — real processes, PTYs, server boots',
  'test:acceptance   — loop-split load suite',
  'test:bun:unit     — bun-native suites (*.bun.test.ts)',
]

export function parseArgs(argv: string[]): {
  explicitBase: string | null
  allowUncovered: boolean
  forward: string[]
} {
  let explicitBase: string | null = null
  let allowUncovered = false
  const forward: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--base') explicitBase = argv[++i] ?? ''
    else if (a.startsWith('--base=')) explicitBase = a.slice('--base='.length)
    else if (a === '--allow-uncovered') allowUncovered = true
    else forward.push(a)
  }
  return { explicitBase, allowUncovered, forward }
}

async function main() {
  const root = join(import.meta.dir, '..')
  const git: Git = (args) => {
    const p = Bun.spawnSync(['git', ...args], { cwd: root })
    if (p.exitCode !== 0) return null
    return p.stdout.toString().trim()
  }

  const census = readCensus(root)
  if (census.links.filter((l) => !l.endsWith('!DANGLING')).length === 0) {
    console.error(
      'test:affected refused: node_modules/@podium has no usable workspace links — this ' +
        'checkout is not installed, and a green here would not be evidence (POD-1343). ' +
        'Run `bun install` first.',
    )
    process.exit(1)
  }

  const { explicitBase, allowUncovered, forward } = parseArgs(
    process.argv.slice(2),
  )
  const envBase = process.env.PODIUM_TEST_BASE || null
  const decision = resolveBase(git, { explicit: explicitBase ?? envBase })
  if ('error' in decision) {
    console.error(`test:affected refused: ${decision.error}`)
    process.exit(1)
  }

  const files = changedFiles(git, decision.base)
  const { uncovered, reasons } = assessCoverage(files, readPackages(root))

  console.error(`test:affected — base: ${decision.how}`)
  console.error(`  ${files.length} changed file(s) vs base`)
  console.error('\nthis lane does NOT run, at any time:')
  for (const lane of NOT_COVERED) console.error(`  ${lane}`)
  console.error('run `bun run test` before you commit.\n')

  if (uncovered.length > 0 && !allowUncovered) {
    console.error(
      'test:affected refused: these changed files are INVISIBLE to the `test` task —\n' +
        'no package filter can select them, so a pass here would not mean they are tested:\n',
    )
    for (const f of uncovered.slice(0, 25)) console.error(`  ${f}\n    ${reasons.get(f)}`)
    if (uncovered.length > 25) console.error(`  … and ${uncovered.length - 25} more`)
    console.error(
      '\nRun the full lane instead:\n' +
        '  bun run test\n\n' +
        'or, once you have run it yourself and want the fast loop back:\n' +
        '  bun run test:affected -- --allow-uncovered',
    )
    process.exit(1)
  }

  const proc = Bun.spawn(
    [
      join(root, 'node_modules', '.bin', 'turbo'),
      'run',
      'test',
      `--filter=...[${decision.base}]`,
      ...forward,
    ],
    {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, PODIUM_CHECK_ENV_HASH: fingerprint(census) },
    },
  )
  process.exit(await proc.exited)
}

if (import.meta.main) await main()
