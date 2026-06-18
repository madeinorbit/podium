import { spawnSync } from 'node:child_process'

/** True when the `opencode` binary is on PATH and responds to --version. */
export function isOpencodeCliAvailable(): boolean {
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** True when `opencode --help` succeeds — a slightly stronger install check. */
export function validateOpencodeCliHelp(): boolean {
  try {
    const res = spawnSync('opencode', ['--help'], { encoding: 'utf8' })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return res.status === 0 && text.includes('opencode')
  } catch {
    return false
  }
}
