import { machinePathSeparator, normalizeMachinePath } from '@podium/model/browser'

/** Collapse the conventional user home directory for a compact, native cwd display. */
export function prettyCwd(path: string): string {
  if (machinePathSeparator(path) === '\\')
    return normalizeMachinePath(path).replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')
  return path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
}
