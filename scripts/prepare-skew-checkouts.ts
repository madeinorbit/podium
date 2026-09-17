/**
 * Materialise the real old release trees the customer-upgrade skew lane runs
 * against [POD-3974]. Each is a detached git worktree pinned to an immutable
 * release tag, with its own dependencies installed, so the lane launches the
 * genuine old daemon/server entrypoint and its own `@podium/protocol` wire —
 * never relabelled current code.
 *
 *   bun scripts/prepare-skew-checkouts.ts            # into the default dir
 *   PODIUM_SKEW_DIR=/path bun scripts/prepare-skew-checkouts.ts
 *
 * Idempotent: an existing checkout at the right tag is left in place.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKEW_DIR = process.env.PODIUM_SKEW_DIR ?? join(dirname(ROOT), 'podium-skew-checkouts')

/** Pinned by tag AND commit; the lane's wire facts are asserted against these. */
const CHECKOUTS = [
  { tag: 'v0.1.0', commit: '241dd542e1494c68080d5fd2ef441d7c2e195b12' },
  { tag: 'v0.1.1-edge.4', commit: 'd09e5d47a4c3200c2ded231269d91ff0d1d90cd1' },
] as const

const git = (args: string[], cwd = ROOT) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()

for (const { tag, commit } of CHECKOUTS) {
  const dir = join(SKEW_DIR, tag)
  if (existsSync(join(dir, 'scripts', 'cli.ts'))) {
    const head = git(['rev-parse', 'HEAD'], dir)
    if (head === commit) {
      console.log(`skew: ${tag} already at ${commit.slice(0, 12)}`)
      continue
    }
    throw new Error(`skew: ${dir} is at ${head.slice(0, 12)}, expected ${commit.slice(0, 12)} for ${tag}`)
  }
  const resolved = git(['rev-parse', `${tag}^{commit}`])
  if (resolved !== commit) throw new Error(`skew: tag ${tag} resolves to ${resolved}, pinned to ${commit}`)
  console.log(`skew: adding worktree ${dir} at ${tag} (${commit.slice(0, 12)})`)
  git(['worktree', 'add', '--detach', dir, commit])
  console.log(`skew: installing ${tag} dependencies`)
  execFileSync('bun', ['install'], { cwd: dir, stdio: 'inherit' })
}
console.log(`skew: checkouts ready under ${SKEW_DIR}`)
