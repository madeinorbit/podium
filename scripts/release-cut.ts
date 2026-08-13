/**
 * Cut a release: bump the version, promote the changelog, commit, tag, push.
 *
 * WHY THIS EXISTS. Releasing was three manual steps — edit `package.json`, commit, tag — whose
 * failure mode is a tag that disagrees with the version it claims to ship. CI refuses that
 * mismatch, but only after the tag is already pushed and has to be deleted. One command that does
 * all three cannot produce the disagreement in the first place.
 *
 * WHY IT TOUCHES THE CHANGELOG. Release notes come from `CHANGELOG.md` (see `extractRelease`),
 * not from a workflow input, so the notes for a version must exist under that version's heading
 * before the tag is pushed. Promoting `## [Unreleased]` to `## [<version>]` here is what makes a
 * tag-driven release carry notes at all — writing them in the same commit that names the version
 * is the only arrangement where the two cannot drift.
 *
 * Usage:
 *   bun run release:cut 0.2.0            # stable
 *   bun run release:cut 0.2.0-edge.1     # edge
 *   bun run release:cut 0.2.0 --dry-run  # print what would happen, change nothing
 *   bun run release:cut 0.2.0 --no-push  # commit and tag locally, push by hand
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Semver, restricted to the two shapes this project releases. */
const STABLE = /^\d+\.\d+\.\d+$/
const EDGE = /^\d+\.\d+\.\d+-edge\.\d+$/

export type ReleaseChannel = 'stable' | 'edge'

/**
 * Classify a version string, rejecting anything the release workflow would refuse later.
 *
 * A prerelease that names no channel (`0.2.0-rc1`) is the dangerous case: the tag workflow
 * refuses it, but only after the tag exists, so catch it here where nothing has been created yet.
 */
export function channelForVersion(version: string): ReleaseChannel {
  if (STABLE.test(version)) return 'stable'
  if (EDGE.test(version)) return 'edge'
  throw new Error(
    `version "${version}" is neither X.Y.Z (stable) nor X.Y.Z-edge.N (edge).\n` +
      'Those are the only two shapes the release workflow can route to a channel.',
  )
}

/** Numeric comparison of two release versions; edge prereleases sort before their stable. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const [core = '', pre] = v.split('-edge.')
    const parts = core.split('.').map((n) => Number.parseInt(n, 10))
    // A stable release outranks every edge prerelease of the same core version, so absent
    // prerelease sorts LAST — the standard semver rule, spelled out because getting it backwards
    // would let `release:cut` accept a version the updater then ignores as not newer.
    parts.push(pre === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(pre, 10))
    return parts
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * Move everything under `## [Unreleased]` into a new `## [<version>] - <date>` section and leave a
 * fresh empty Unreleased behind. Returns the rewritten changelog and the promoted notes.
 *
 * An empty Unreleased is allowed — an edge build cut purely to test a pipeline has nothing to say
 * — but it is reported, because a release that silently ships no notes is usually a mistake.
 */
export function promoteUnreleased(
  markdown: string,
  version: string,
  date: string,
): { markdown: string; notes: string } {
  const heading = /^##[ \t]+\[?Unreleased\]?[ \t]*$/im
  const match = markdown.match(heading)
  if (!match || match.index === undefined) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" heading to promote')
  }
  const bodyStart = match.index + match[0].length
  const nextHeading = markdown.slice(bodyStart).search(/^##[ \t]+/m)
  const bodyEnd = nextHeading === -1 ? markdown.length : bodyStart + nextHeading
  const notes = markdown.slice(bodyStart, bodyEnd).trim()

  const rewritten =
    `${markdown.slice(0, match.index)}## [Unreleased]\n\n## [${version}] - ${date}\n\n` +
    `${notes ? `${notes}\n\n` : ''}${markdown.slice(bodyEnd).replace(/^\n+/, '')}`
  return { markdown: rewritten, notes }
}

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fail(message: string): never {
  console.error(`\n[release:cut] ${message}\n`)
  process.exit(1)
}

function run(): void {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const noPush = args.includes('--no-push')
  const version = args.find((a) => !a.startsWith('--'))
  if (!version) {
    fail('usage: bun run release:cut <version> [--dry-run] [--no-push]')
  }

  const channel = channelForVersion(version)

  const packagePath = `${REPO_ROOT}package.json`
  const packageText = readFileSync(packagePath, 'utf8')
  const current = (JSON.parse(packageText) as { version: string }).version
  if (compareVersions(version, current) <= 0) {
    fail(
      `${version} is not greater than the current ${current}.\n` +
        "Tauri's updater ignores a version it has already seen, so a release at or below the\n" +
        'current version reaches no existing install.',
    )
  }

  // A dirty tree would sweep unrelated work into the release commit, and a stale branch would tag
  // a commit that is not what CI builds.
  if (!dryRun) {
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
      fail('working tree has uncommitted changes — commit or stash them first')
    }
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    git(['fetch', '--quiet', 'origin', branch])
    if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', `origin/${branch}`])) {
      fail(`${branch} differs from origin/${branch} — pull or push first so the tag matches CI`)
    }
    if (
      spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/v${version}`], {
        cwd: REPO_ROOT,
      }).status === 0
    ) {
      fail(`tag v${version} already exists`)
    }
  }

  const changelogPath = `${REPO_ROOT}CHANGELOG.md`
  const date = new Date().toISOString().slice(0, 10)
  const { markdown, notes } = promoteUnreleased(readFileSync(changelogPath, 'utf8'), version, date)

  console.log(`[release:cut] ${current} -> ${version} (${channel})`)
  console.log(
    notes
      ? `[release:cut] notes:\n${notes.replace(/^/gm, '    ')}`
      : '[release:cut] NOTE: the Unreleased section is empty, so this release ships no notes.',
  )

  if (dryRun) {
    console.log('\n[release:cut] --dry-run: nothing written, committed, tagged, or pushed.')
    return
  }

  // Replace only the top-level "version" field: a blunt JSON.stringify would reformat the whole
  // file and bury the one-line change every reviewer wants to see.
  // The closing quote is the anchor, NOT a trailing comma: `version` is usually followed by more
  // fields, but a package.json where it is the last key has no comma and must still bump.
  const bumped = packageText.replace(
    /^(\s*"version":\s*")[^"]+(")/m,
    (_match, prefix: string, suffix: string) => `${prefix}${version}${suffix}`,
  )
  if (bumped === packageText) fail('could not find the "version" field in package.json')
  writeFileSync(packagePath, bumped)
  writeFileSync(changelogPath, markdown)

  git(['add', 'package.json', 'CHANGELOG.md'])
  git(['commit', '--message', `Release ${version}`])
  git(['tag', '--annotate', `v${version}`, '--message', `Release ${version}`])
  console.log(`[release:cut] committed and tagged v${version}`)

  if (noPush) {
    console.log(
      `[release:cut] --no-push: run \`git push origin HEAD && git push origin v${version}\``,
    )
    return
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  git(['push', 'origin', branch])
  // The tag push is what starts the release, so it goes LAST — if the branch push fails, CI must
  // not already be building a commit that never landed.
  git(['push', 'origin', `v${version}`])
  console.log(`[release:cut] pushed ${branch} and v${version} — the release workflows are running.`)
}

/**
 * Every failure here is an operator mistake — a bad version, a dirty tree, an unparseable
 * package.json — and a stack trace buries the one line that says which. Print the message.
 */
function main(): void {
  try {
    run()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (import.meta.main) main()
