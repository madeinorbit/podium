/**
 * The gitignored results dir (`harness/browser/results/`), lane-independent:
 * turbo runs the package lane with cwd at the package, `test:file` and the
 * unit lane with the repo root.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writeResult(name: string, value: unknown): string {
  const cwd = process.cwd()
  const dir = cwd.endsWith(join('packages', 'worklist-proto'))
    ? join(cwd, 'harness', 'browser', 'results')
    : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.json`)
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}
