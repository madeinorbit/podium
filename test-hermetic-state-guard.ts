import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

type StateDirEnv = { PODIUM_STATE_DIR?: string }

/** Refuse any test case that could fall back to the live ~/.podium state tree. */
export function assertHermeticStateDir(
  env: StateDirEnv = process.env,
  liveStateDir = join(homedir(), '.podium'),
): string {
  const configured = env.PODIUM_STATE_DIR?.trim()
  if (!configured) {
    throw new Error(
      '[test isolation] PODIUM_STATE_DIR is required for every test case; refusing ~/.podium fallback',
    )
  }

  const resolvedStateDir = resolve(configured)
  const resolvedLiveStateDir = resolve(liveStateDir)
  const pathFromLiveState = relative(resolvedLiveStateDir, resolvedStateDir)
  const isWithinLiveState =
    pathFromLiveState === '' ||
    (pathFromLiveState !== '..' &&
      !pathFromLiveState.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromLiveState))
  if (isWithinLiveState) {
    throw new Error(
      `[test isolation] PODIUM_STATE_DIR must not use the live state tree: ${resolvedStateDir}`,
    )
  }

  return resolvedStateDir
}
