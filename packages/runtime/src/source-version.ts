import { execFileSync } from 'node:child_process'

export function developmentSourceVersion(
  root: string,
  readHead: (root: string) => string = (cwd) =>
    String(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd })),
): string {
  try {
    const sha = readHead(root).trim().toLowerCase()
    return /^[0-9a-f]{7,40}$/.test(sha) ? `dev+${sha.slice(0, 7)}` : 'dev'
  } catch {
    return 'dev'
  }
}
