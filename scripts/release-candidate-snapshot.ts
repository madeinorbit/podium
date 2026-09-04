/** Seal the prepared release directory across the acceptance proof and publish. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export type CandidateSnapshot = Array<{ path: string; sha256: string }>

function filesBelow(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`candidate contains a symbolic link: ${relative(root, path)}`)
    }
    if (entry.isDirectory()) return filesBelow(root, path)
    if (!entry.isFile()) throw new Error(`candidate contains a non-file: ${relative(root, path)}`)
    return [path]
  })
}

export function snapshotCandidate(dir: string): CandidateSnapshot {
  return filesBelow(dir)
    .map((path) => ({
      path: relative(dir, path),
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export function verifyCandidateSnapshot(dir: string, expectedPath: string): void {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as CandidateSnapshot
  const actual = snapshotCandidate(dir)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'prepared release candidate changed after its v0.1.0 acceptance proof; refusing to publish different bytes',
    )
  }
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

if (import.meta.main) {
  const dir = arg('--dir')
  if (!dir) throw new Error('--dir is required')
  const write = arg('--write')
  const verify = arg('--verify')
  if ((write ? 1 : 0) + (verify ? 1 : 0) !== 1) {
    throw new Error('choose exactly one of --write or --verify')
  }
  if (write) {
    writeFileSync(write, `${JSON.stringify(snapshotCandidate(dir), null, 2)}\n`)
    console.log('[release-candidate] sealed prepared bytes')
  } else {
    verifyCandidateSnapshot(dir, verify!)
    console.log('[release-candidate] prepared bytes still match the accepted candidate')
  }
}
