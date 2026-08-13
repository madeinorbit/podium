import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function defaultReadHead(cwd: string): string {
  return String(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd }))
}

/** Seven-character HEAD, or undefined when git is unavailable or not a SHA. */
export function developmentSourceSha(
  root: string,
  readHead: (root: string) => string = defaultReadHead,
): string | undefined {
  try {
    const sha = readHead(root).trim().toLowerCase()
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : undefined
  } catch {
    return undefined
  }
}

/** Product version of a source checkout: dest+<sha>, never `-dirty`. */
export function developmentSourceVersion(
  root: string,
  readHead: (root: string) => string = defaultReadHead,
): string {
  const sha = developmentSourceSha(root, readHead)
  return sha ? `dev+${sha}` : 'dev'
}

/** This package's own checkout, for a source run. Meaningless inside a compiled
 *  binary — which never asks, because `PODIUM_APP_VERSION` is baked into those. */
export function repositorySourceRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url))
}

export interface DevelopmentLogVersionDeps {
  readHead?: (root: string) => string
  /** `git status --porcelain` in `root`. Anything non-empty means dirty. */
  readStatus?: (root: string) => string
}

/**
 * WHICH SOURCE IS THIS PROCESS RUNNING? — the `v` a source run stamps its log
 * records with (POD-1965).
 *
 * The constant `dev` was worse than it looked. It was PRESENT, so every field
 * check passed and nothing appeared broken, and it was CONSTANT, so no log line
 * could say whether the process writing it contained a given fix. A reader
 * chasing "did this machine have POD-1954's fix?" got the same six characters
 * either way.
 *
 * `dev+<sha>` answers the commit; `-dirty` answers the rest of it. Uncommitted
 * edits are the normal state of the development host — the live server runs the
 * main checkout's working tree — so a bare sha there would name a commit whose
 * code is not what is running, which is the same lie in a longer form.
 *
 * DELIBERATELY NOT `serverBuildVersion()`. That value is compared for equality
 * against a published update target (`apps/server/src/modules/updates/trpc.ts`),
 * and a dev bundle is only ever published from a clean tree — so appending
 * `-dirty` there would make an edited checkout read as permanently behind. The
 * update story wants the identity of the SOURCE; a log line wants the identity
 * of what is actually running. They agree whenever the tree is clean.
 */
export function developmentLogVersion(
  root: string = repositorySourceRoot(),
  deps: DevelopmentLogVersionDeps = {},
): string {
  const base = developmentSourceVersion(root, deps.readHead)
  if (base === 'dev') return 'dev'
  try {
    const readStatus =
      deps.readStatus ??
      ((cwd: string) => String(execFileSync('git', ['status', '--porcelain', '-z'], { cwd })))
    return readStatus(root).trim() === '' ? base : `${base}-dirty`
  } catch {
    // A sha we are only mostly sure about still beats `dev`, which is a sha we
    // know nothing about.
    return base
  }
}
