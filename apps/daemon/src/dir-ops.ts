import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import type { DirOp } from '@podium/protocol'

const execFileAsync = promisify(execFile)
const log = createLogger('daemon:dir-ops')

/**
 * THE PICKER'S WRITE SIDE (POD-1295) — the counterpart to `listDirectories`.
 *
 * "Find a repository" could only ever find one that already existed, so a fresh
 * machine dead-ended into a shell. These three ops are what it takes to leave
 * that state from inside the dialog, and they are deliberately the *smallest*
 * filesystem surface that does: make a folder, rename a folder, make a folder a
 * repository. No delete, no move between directories, no recursive create.
 *
 * ---------------------------------------------------------------------------
 * A NAME IS NOT A PATH
 * ---------------------------------------------------------------------------
 * Every op takes a `parentPath` (a directory) and a `name` (ONE segment), and
 * the join happens here, after the parent has been resolved through `realpath`.
 * The server never composes a path for the daemon to trust. That is why the
 * validation below has no filesystem semantics in it at all: a segment
 * containing `/`, `..`, or a NUL is refused as a NAME, before anything touches
 * the disk, rather than being normalised into something that looks safe.
 */

/** Longest name most filesystems accept for one component. */
const MAX_SEGMENT_BYTES = 255

/** Every git call here is a fixed argv through execFile — no shell, ever. */
const GIT_TIMEOUT_MS = 60_000

/** A refusal the user is meant to read, as opposed to a thrown bug. */
class DirOpError extends Error {}

/** The name as it will be used: surrounding whitespace is the one thing we fix
 *  silently, because a trailing space in a folder name is never intended and is
 *  invisible in the field the user typed it into. */
export function normalizeSegment(name: string): string {
  return name.trim()
}

/**
 * Why this name cannot be a folder, or null when it can. Message text is
 * user-facing: it travels to the picker unchanged.
 */
export function segmentError(name: string): string | null {
  const segment = normalizeSegment(name)
  if (segment === '') return 'Enter a name for the folder'
  if (segment === '.' || segment === '..') return `"${segment}" is not a folder name`
  if (segment.includes('/')) return 'A folder name cannot contain "/"'
  // Not reachable through JSON in practice; refused anyway, because "cannot
  // happen" is not a property this layer is allowed to assume about its input.
  if (segment.includes('\0')) return 'A folder name cannot contain that character'
  // A leading dash must never reach a git argv slot as a value that could parse
  // as an option — the same guard `repo-op.ts` applies to refs.
  if (segment.startsWith('-')) return 'A folder name cannot start with "-"'
  if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return 'That name is too long'
  return null
}

function expandHome(path: string, homePath: string): string {
  if (path === '~') return homePath
  if (path.startsWith('~/')) return join(homePath, path.slice(2))
  return path
}

/** Resolve `path` to a real directory, or refuse with a readable reason. */
async function resolveDirectory(path: string, homePath: string): Promise<string> {
  const requested = expandHome(path.trim() || homePath, homePath)
  if (!isAbsolute(requested)) throw new DirOpError(`Folder path must be absolute: ${requested}`)
  try {
    const s = await stat(requested)
    if (!s.isDirectory()) throw new DirOpError(`${requested} is not a folder`)
  } catch (err) {
    if (err instanceof DirOpError) throw err
    throw new DirOpError(`Could not open ${requested}: ${reason(err)}`)
  }
  return await realpath(requested)
}

/** Does something already occupy this path? `lstat`, so a dangling symlink
 *  counts — `mkdir` would fail on it too, and "already here" is the honest
 *  reason rather than whatever errno the link produces. */
async function occupied(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function code(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined
}

/** Create `name` inside `parentPath` and return where it landed. */
async function createFolder(parentPath: string, name: string, homePath: string): Promise<string> {
  const invalid = segmentError(name)
  if (invalid) throw new DirOpError(invalid)
  const segment = normalizeSegment(name)
  const parent = await resolveDirectory(parentPath, homePath)
  const target = join(parent, segment)

  if (await occupied(target)) throw new DirOpError(`"${segment}" is already here`)
  try {
    // Not recursive: the parent was resolved above, and a recursive mkdir would
    // quietly create a chain of folders nobody asked for if it ever were.
    // 0o700 matches what the clone path already creates a checkout's parent as.
    await mkdir(target, { mode: 0o700 })
  } catch (err) {
    if (code(err) === 'EEXIST') throw new DirOpError(`"${segment}" is already here`)
    if (code(err) === 'EACCES' || code(err) === 'EPERM') {
      throw new DirOpError(`Podium can't write to ${parent}`)
    }
    throw new DirOpError(`Could not create "${segment}": ${reason(err)}`)
  }

  // Defense in depth: `name` has no separator and `parent` is already real, so
  // this can only fail if the tree changed underneath us mid-call.
  const real = await realpath(target)
  if (dirname(real) !== parent) {
    throw new DirOpError(`Could not create "${segment}" in ${parent}`)
  }
  return real
}

/** Rename `currentName` to `name`, both inside `parentPath`. */
async function renameFolder(
  parentPath: string,
  currentName: string,
  name: string,
  homePath: string,
): Promise<string> {
  const invalidSource = segmentError(currentName)
  if (invalidSource) throw new DirOpError(invalidSource)
  const invalid = segmentError(name)
  if (invalid) throw new DirOpError(invalid)

  const parent = await resolveDirectory(parentPath, homePath)
  const from = join(parent, normalizeSegment(currentName))
  const to = join(parent, normalizeSegment(name))
  if (from === to) return from

  try {
    const s = await lstat(from)
    if (!s.isDirectory()) throw new DirOpError(`${from} is not a folder`)
  } catch (err) {
    if (err instanceof DirOpError) throw err
    throw new DirOpError(`Could not open ${from}: ${reason(err)}`)
  }
  if (await occupied(to)) throw new DirOpError(`"${normalizeSegment(name)}" is already here`)

  try {
    await rename(from, to)
  } catch (err) {
    if (code(err) === 'EACCES' || code(err) === 'EPERM') {
      throw new DirOpError(`Podium can't rename folders in ${parent}`)
    }
    throw new DirOpError(`Could not rename "${normalizeSegment(currentName)}": ${reason(err)}`)
  }
  return to
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

/** Is this git identity field set anywhere git would read it? */
async function configured(cwd: string, key: string): Promise<boolean> {
  try {
    return (await git(cwd, ['config', '--get', key])) !== ''
  } catch {
    // `git config --get` exits 1 for "not set", which execFile reports as a
    // rejection. Unset is the answer, not a failure.
    return false
  }
}

/**
 * Turn a folder into a repository that can actually take work.
 *
 * TWO THINGS HERE ARE THE WHOLE POINT, and both are invisible until onboarding
 * breaks a day later:
 *
 * 1. THE SEED COMMIT. `git worktree add -b <branch> <path>` — how every issue
 *    gets its worktree (`repo-op.ts`) — cannot resolve HEAD on a repository
 *    with no commits. A bare `git init` therefore produces a repo that
 *    registers perfectly and fails on the user's first task.
 * 2. THE IDENTITY FALLBACK. `git commit` refuses without `user.email`, which is
 *    exactly the state of the machine this feature exists for. The fallback is
 *    passed per-invocation with `-c`, so the seed commit succeeds without
 *    writing anything into the user's global config.
 *
 * `commit.gpgsign=false` for the same class of reason: a global signing config
 * with no key on this machine would otherwise fail a commit the user never
 * asked to sign. `--no-verify` skips hooks a global template may have installed
 * — a seed commit is not the place to run someone's pre-commit suite.
 */
async function initRepository(path: string, folderName: string, machine: string): Promise<void> {
  try {
    await git(path, ['init', '-b', 'main'])
  } catch (err) {
    if (code(err) === 'ENOENT') {
      throw new DirOpError(`git is not installed on ${machine}`)
    }
    // `-b` needs git >= 2.28. Older git still initialises fine; name the branch
    // afterwards so the result is the same repository either way.
    try {
      await git(path, ['init'])
      await git(path, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    } catch (fallbackErr) {
      throw new DirOpError(`Could not run git init: ${reason(fallbackErr)}`)
    }
  }

  // One tracked file, so the seed commit has a tree. A README is the file a new
  // project would grow anyway, and it names itself.
  await writeFile(join(path, 'README.md'), `# ${folderName}\n`, 'utf8')

  const identity: string[] = []
  if (!(await configured(path, 'user.name'))) identity.push('-c', 'user.name=Podium')
  if (!(await configured(path, 'user.email'))) identity.push('-c', `user.email=podium@${machine}`)

  try {
    await git(path, ['add', '-A'])
    await git(path, [
      ...identity,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'Initial commit',
    ])
  } catch (err) {
    throw new DirOpError(`Could not create the first commit: ${reason(err)}`)
  }
}

/**
 * Run one op and describe the outcome. Never rejects: a refusal is a RESULT the
 * picker renders, the same contract `browseDirs` already has.
 *
 * `path` and `error` can both come back — `createRepo` may create the folder
 * and then fail to make it a repository (no git on the machine), and the user
 * needs to see the folder that now exists as well as why it is not usable yet.
 */
export async function runDirOp(
  op: DirOp,
  input: { parentPath: string; name: string; currentName?: string },
  options: { homePath: string; machine: string },
): Promise<{ path?: string; error?: string }> {
  try {
    if (op === 'renameFolder') {
      if (input.currentName === undefined) return { error: 'Nothing to rename' }
      return {
        path: await renameFolder(input.parentPath, input.currentName, input.name, options.homePath),
      }
    }

    const path = await createFolder(input.parentPath, input.name, options.homePath)
    if (op === 'createFolder') return { path }

    try {
      await initRepository(path, normalizeSegment(input.name), options.machine)
    } catch (err) {
      // The folder is real and the user can see it; report both halves.
      return { path, error: err instanceof DirOpError ? err.message : reason(err) }
    }
    return { path }
  } catch (err) {
    if (err instanceof DirOpError) return { error: err.message }
    log.warn('dir op failed', { op, err })
    return { error: reason(err) }
  }
}
