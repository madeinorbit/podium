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
 *  Ordinary dot/parent segments remain valid; POSIX names keep their literal spelling.
 *  The rule also holds for the name before an NTFS stream suffix: Windows trims
 *  `.. ` and `...` to `..` there as well, so `.. ::$INDEX_ALLOCATION` and
 *  `...::$INDEX_ALLOCATION` are parent steps no dot-segment test would see. */
export function isValidMachinePath(path: string, root: string = path): boolean {
  return (
    machinePathSeparator(root) === '/' ||
    machinePathSegments(path, root).every((part) => {
      if (part === '.' || part === '..') return true
      if (/[ .]$/.test(part)) return false
      const name = part.split(':', 1)[0] as string
      return name === '.' || name === '..' || !/[ .]$/.test(name)
    })
  )
}

/** The dot segment `part` spells, if any. Under Windows syntax the name is what precedes
 *  an NTFS stream suffix: `..::$INDEX_ALLOCATION` and `.::$DATA` count as `..` and `.`,
 *  since stream-suffix spellings have been used to slip parent steps past path filters.
 *  A POSIX name keeps its literal spelling; `..:x` is an ordinary file there. */
function dotSegment(part: string, windows: boolean): '.' | '..' | undefined {
  const name = windows ? part.split(':', 1)[0] : part
  return name === '.' || name === '..' ? name : undefined
}

/** A `.` or `..` segment, in the root's syntax (with a stream suffix on Windows, see
 *  dotSegment). Containment answers only for paths spelled without them: a literal POSIX
 *  prefix test counts `/repo/../etc` as inside `/repo`, and a lexically resolved `..` can
 *  name another folder than the filesystem does across a symlink.
 *  A caller holding a relative token resolves it first (resolveMachinePath). */
export function machinePathHasDotSegment(path: string, root: string = path): boolean {
  const windows = machinePathSeparator(root) === '\\'
  return machinePathSegments(path, root).some((part) => dotSegment(part, windows) !== undefined)
}

/** Whether `path` is spelled in the syntax of a machine whose Node platform is `os`: a
 *  drive or UNC root on Windows, a `/` root on Linux and macOS. Every helper here infers
 *  the syntax from the spelling, so a POSIX-spelled root on a Windows machine would keep
 *  backslashes literal while the machine treats them as separators. Registration refuses
 *  such a path. */
export function isMachinePathForOs(path: string, os: 'linux' | 'darwin' | 'win32'): boolean {
  return os === 'win32'
    ? isAbsoluteMachinePath(path) && machinePathSeparator(path) === '\\'
    : path.startsWith('/')
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

/** Normalize dot segments without ever walking above a drive, share or POSIX root.
 * Invalid Windows spelling stays literal for display/identity; authorization must use
 * isValidMachinePath or the containment helpers, which refuse those segments. */
export function normalizeMachinePath(path: string, root: string = path): string {
  if (!isValidMachinePath(path, root)) return path.replace(/\//g, '\\')
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
  if (machinePathSeparator(root) === '/') return machinePathSegments(path, root).at(-1) ?? ''
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

/** Relative path when contained; null when outside (including a different drive/share).
 *  Refuses an empty root, a root with a dot segment, an absolute path with one, and any
 *  `..`: only a relative token may carry `.` (`./shot.png`), which cannot climb out. */
export function machinePathRelativeToRoot(root: string, path: string): string | null {
  if (root === '') return null
  if (!isValidMachinePath(root) || !isValidMachinePath(path, root)) return null
  if (machinePathHasDotSegment(root)) return null
  // Only a plain `.` may stay (`./shot.png`); `..`, and `.` with a stream suffix, may not.
  const windows = machinePathSeparator(root) === '\\'
  if (machinePathSegments(path, root).some((part) => part !== '.' && dotSegment(part, windows)))
    return null
  if (isAbsoluteMachinePath(path, root) && machinePathHasDotSegment(path, root)) return null
  const base = normalizeMachinePath(root)
  // A relative root and cwd are already in the same namespace (repo + repo/sub).
  const target = isAbsoluteMachinePath(base)
    ? resolveMachinePath(base, path)
    : normalizeMachinePath(path, root)
  const separator = machinePathSeparator(base)
  if (separator === '\\') {
    const from = pathParts(base, separator)
    const to = pathParts(target, separator)
    const fromParts = from.parts.filter(Boolean)
    const toParts = to.parts.filter(Boolean)
    if (
      foldMachinePathCase(from.root) !== foldMachinePathCase(to.root) ||
      fromParts.length > toParts.length
    )
      return null
    for (let i = 0; i < fromParts.length; i++) {
      if (foldMachinePathCase(fromParts[i]!) !== foldMachinePathCase(toParts[i]!)) return null
    }
    return toParts.slice(fromParts.length).join(separator)
  }
  if (base === target) return ''
  const prefix = base.endsWith(separator) ? base : base + separator
  return target.startsWith(prefix) ? target.slice(prefix.length) : null
}

/** Whether the folder `path` is `root` or lies under it. Refuses a dot segment in either
 *  (machinePathHasDotSegment), on POSIX, Windows and UNC alike, and an empty root, which as
 *  a literal prefix would contain every absolute POSIX path. */
export function isMachinePathWithinRoot(root: string, path: string): boolean {
  if (root === '') return false
  if (!isValidMachinePath(root) || !isValidMachinePath(path, root)) return false
  if (machinePathHasDotSegment(root) || machinePathHasDotSegment(path, root)) return false
  // Keep POSIX cwd membership literal (including relative roots and trailing slashes).
  // Unlike resolving a file token, membership must never put a relative cwd under an absolute root.
  if (machinePathSeparator(root) === '/')
    return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
  // A POSIX cwd is not a drive-root-relative Windows file token. Resolving it
  // against the checkout's drive would make another machine's path match.
  if (machinePathSeparator(path) === '/' && isAbsoluteMachinePath(path)) return false
  if (isAbsoluteMachinePath(root) && !isAbsoluteMachinePath(path)) return false
  return machinePathRelativeToRoot(root, path) !== null
}

/** Match a truncated/relative file token at a segment boundary, in the full path's syntax. */
export function machinePathHasSuffix(path: string, suffix: string): boolean {
  if (!isValidMachinePath(path) || !isValidMachinePath(suffix, path)) return false
  const separator = machinePathSeparator(path)
  const full = normalizeMachinePath(path)
  const tail = normalizeMachinePath(suffix, path)
  const a = separator === '\\' ? foldMachinePathCase(full) : full
  const b = separator === '\\' ? foldMachinePathCase(tail) : tail
  // A parent-relative token must resolve against its cwd, never match a truncated basename.
  return (
    a === b ||
    (!isAbsoluteMachinePath(suffix, path) &&
      !machinePathSegments(suffix, path).includes('..') &&
      a.endsWith(separator + b))
  )
}

/** ASCII folding cannot expand a segment or alias Unicode characters to ASCII. */
function foldMachinePathCase(path: string): string {
  return path.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

/** Stable comparison/key spelling. POSIX identity stays literal; Windows folds separators and case. */
export function machinePathKey(path: string): string {
  return machinePathSeparator(path) === '\\'
    ? foldMachinePathCase(normalizeMachinePath(path))
    : path
}

export function machinePathsEqual(a: string, b: string): boolean {
  return machinePathKey(a) === machinePathKey(b)
}

/** Directory ancestors, nearest first, without normalizing literal POSIX spelling.
 *  The indexed form of isMachinePathWithinRoot, so a path with a dot segment has none. */
export function machinePathAncestors(path: string): string[] {
  if (!isValidMachinePath(path) || machinePathHasDotSegment(path)) return []
  if (machinePathSeparator(path) === '\\') {
    const ancestors: string[] = []
    let current = normalizeMachinePath(path)
    for (;;) {
      ancestors.push(current)
      const parent = machinePathDirname(current)
      if (parent === current || parent === '.') return ancestors
      current = parent
    }
  }
  const ancestors = [path]
  for (let at = path.lastIndexOf('/'); at >= 0; at = path.lastIndexOf('/', at - 1)) {
    ancestors.push(at === 0 ? '/' : path.slice(0, at))
    if (at === 0) break
  }
  return [...new Set(ancestors)]
}
