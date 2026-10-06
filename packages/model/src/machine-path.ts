/**
 * Paths on a MACHINE, judged by code that may run somewhere else (a browser, a phone).
 * Infer the machine's path syntax from its root, never from the client's OS.
 * URL routes and portable artifact-store entry paths do not use these helpers.
 */

/** `/x` on POSIX; `C:\\x`, `C:/x` or a UNC `\\\\server\\share` on Windows. */
export function isAbsoluteMachinePath(path: string, root?: string): boolean {
  if (root !== undefined && machinePathSeparator(root) === '/') return path.startsWith('/')
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)
}

/** Windows roots use native backslashes, including roots received with forward slashes. */
export function machinePathSeparator(root: string): '/' | '\\' {
  return /^[A-Za-z]:[\\/]/.test(root) || /^\\\\[^\\]/.test(root) ? '\\' : '/'
}

/** A POSIX root keeps backslashes literal; a Windows root accepts either separator. */
export function machinePathSegments(path: string, root: string = path): string[] {
  return path.split(machinePathSeparator(root) === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean)
}

/** Windows aliases with trailing dots/spaces are refused before any normalization or authorization.
 *  Ordinary dot/parent segments remain valid; POSIX names keep their literal spelling. */
export function isValidMachinePath(path: string, root: string = path): boolean {
  return machinePathSeparator(root) === '/' || machinePathSegments(path, root).every(
    part => part === '.' || part === '..' || !/[ .]$/.test(part),
  )
}

function pathParts(path: string, separator: '/' | '\\'): { root: string; parts: string[] } {
  const value = separator === '\\' ? path.replace(/\//g, '\\') : path
  if (separator === '\\') {
    const unc = /^(\\\\[^\\]+\\[^\\]+)(?:\\|$)/.exec(value)
    if (unc) return { root: `${unc[1]}\\`, parts: value.slice(unc[0].length).split(/\\+/) }
    const drive = /^[A-Za-z]:\\/.exec(value)
    if (drive) return { root: drive[0], parts: value.slice(3).split(/\\+/) }
  }
  const rooted = value.startsWith(separator)
  return { root: rooted ? separator : '', parts: value.split(separator) }
}

/** Normalize dot segments without ever walking above a drive, share or POSIX root. */
export function normalizeMachinePath(path: string, root: string = path): string {
  if (!isValidMachinePath(path, root)) throw new Error('invalid Windows path segment: trailing space or dot')
  const separator = machinePathSeparator(root)
  const parsed = pathParts(path, separator)
  const out: string[] = []
  for (const part of parsed.parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out.at(-1) !== '..') out.pop()
      else if (!parsed.root) out.push(part)
    } else out.push(part)
  }
  return parsed.root + out.join(separator) || '.'
}

/** Join children using the root's machine syntax, accepting mixed Windows separators. */
export function joinMachinePath(root: string, ...children: string[]): string {
  return normalizeMachinePath([root, ...children].join(machinePathSeparator(root)), root)
}

/** Resolve a file against its machine cwd. Rooted Windows paths inherit the cwd's drive/share. */
export function resolveMachinePath(cwd: string, path: string): string {
  if (machinePathSeparator(cwd) === '/') {
    return path.startsWith('/') ? normalizeMachinePath(path, cwd) : joinMachinePath(cwd, path)
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)) return normalizeMachinePath(path)
  if (machinePathSeparator(cwd) === '\\' && /^[\\/]/.test(path)) {
    const root = pathParts(normalizeMachinePath(cwd), '\\').root
    return joinMachinePath(root, path)
  }
  return isAbsoluteMachinePath(path) ? normalizeMachinePath(path) : joinMachinePath(cwd, path)
}

export function machinePathBasename(path: string, root: string = path): string {
  if (path === '') return ''
  const normalized = normalizeMachinePath(path, root)
  const parsed = pathParts(normalized, machinePathSeparator(root))
  return parsed.parts.filter(Boolean).at(-1) ?? parsed.root
}

export function machinePathDirname(path: string, root: string = path): string {
  const separator = machinePathSeparator(root)
  const normalized = normalizeMachinePath(path, root)
  const parsed = pathParts(normalized, separator)
  const parts = parsed.parts.filter(Boolean)
  parts.pop()
  return parsed.root + parts.join(separator) || '.'
}

/** Relative path when contained; null when outside (including a different drive/share). */
export function machinePathRelativeToRoot(root: string, path: string): string | null {
  if (!isValidMachinePath(root) || !isValidMachinePath(path, root)) return null
  const base = normalizeMachinePath(root)
  // A relative root and cwd are already in the same namespace (repo + repo/sub).
  const target = isAbsoluteMachinePath(base)
    ? resolveMachinePath(base, path)
    : normalizeMachinePath(path, root)
  const windows = machinePathSeparator(base) === '\\'
  const comparableBase = windows ? base.toLowerCase() : base
  const comparableTarget = windows ? target.toLowerCase() : target
  if (comparableBase === comparableTarget) return ''
  const prefix = comparableBase.endsWith(machinePathSeparator(base))
    ? comparableBase
    : comparableBase + machinePathSeparator(base)
  return comparableTarget.startsWith(prefix) ? target.slice(prefix.length) : null
}

export function isMachinePathWithinRoot(root: string, path: string): boolean {
  if (!isValidMachinePath(root) || !isValidMachinePath(path, root)) return false
  // Keep POSIX cwd membership literal (including relative roots and trailing slashes).
  // Unlike resolving a file token, membership must never put a relative cwd under an absolute root.
  if (machinePathSeparator(root) === '/')
    return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
  if (isAbsoluteMachinePath(root) && !isAbsoluteMachinePath(path)) return false
  const base = normalizeMachinePath(root).toLowerCase()
  const target = normalizeMachinePath(path, root).toLowerCase()
  return target === base || target.startsWith(base.endsWith('\\') ? base : `${base}\\`)
}

/** Match a truncated/relative file token at a segment boundary, in the full path's syntax. */
export function machinePathHasSuffix(path: string, suffix: string): boolean {
  const separator = machinePathSeparator(path)
  const full = normalizeMachinePath(path)
  const tail = normalizeMachinePath(suffix, path)
  const a = separator === '\\' ? full.toLowerCase() : full
  const b = separator === '\\' ? tail.toLowerCase() : tail
  // A parent-relative token must resolve against its cwd, never match a truncated basename.
  return (
    a === b ||
    (!isAbsoluteMachinePath(suffix, path) &&
      !machinePathSegments(suffix, path).includes('..') &&
      a.endsWith(separator + b))
  )
}

/** Stable comparison/key spelling. POSIX identity stays literal; Windows folds separators and case. */
export function machinePathKey(path: string): string {
  return machinePathSeparator(path) === '\\' ? normalizeMachinePath(path).toLowerCase() : path
}

export function machinePathsEqual(a: string, b: string): boolean {
  return machinePathKey(a) === machinePathKey(b)
}
