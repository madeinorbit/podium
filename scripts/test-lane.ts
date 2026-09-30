/**
 * `bun run test:lane -- <lane> [vitest args]` (POD-3890): one named lane from
 * scripts/test-lanes.ts, with its admission class, and whatever vitest arguments the
 * caller adds (`-t <pattern>`, a path filter, `--reporter`). `--list` prints the lanes.
 */
import { resolve } from 'node:path'
import { runFocusedVitest } from './test-focused'
import { LANES, laneNames, repositoryRoot, splitFileArgs } from './test-lanes'

function usage(): string {
  const width = Math.max(...laneNames().map((name) => name.length))
  const rows = Object.entries(LANES).map(
    ([name, lane]) => `  ${name.padEnd(width)}  ${lane.admission.padEnd(7)}  ${lane.summary}`,
  )
  return `usage: bun run test:lane -- <lane> [vitest args]\n\nlanes:\n${rows.join('\n')}`
}

async function main() {
  const [name, ...extra] = process.argv.slice(2)
  if (!name || name === '--list' || name === '--help') {
    console.error(usage())
    process.exit(name ? 0 : 2)
  }
  const lane = LANES[name]
  if (!lane) {
    console.error(`test:lane: unknown lane "${name}"\n\n${usage()}`)
    process.exit(2)
  }
  const root = repositoryRoot()
  // Accept repository-relative filenames and the lane's own cwd-relative filters.
  const args = splitFileArgs(extra, root, false, lane.cwd)
  if (args.errors.length > 0) {
    for (const error of args.errors) console.error(`test:lane: ${error}`)
    process.exit(2)
  }
  for (const script of lane.before ?? []) {
    const code = await Bun.spawn(['bun', 'run', script], {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
    }).exited
    if (code !== 0) process.exit(code)
  }
  const code = await runFocusedVitest(
    lane,
    root,
    extra,
    args.files.map((file) => resolve(root, file)),
    `test:lane (${name})`,
  )
  process.exit(code)
}

if (import.meta.main) await main()
