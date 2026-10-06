/**
 * Paths on a MACHINE, judged by code that may run somewhere else (a browser, a phone).
 * A machine is POSIX or Windows, so a client cannot use its own `node:path` (it has
 * none) nor assume a leading '/'. The machine itself validates again with its own
 * `isAbsolute`; these helpers only keep a client from refusing a valid Windows path.
 */

/** `/x` on POSIX; `C:\x`, `C:/x` or a UNC `\\server\share` on Windows. */
export function isAbsoluteMachinePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)
}
