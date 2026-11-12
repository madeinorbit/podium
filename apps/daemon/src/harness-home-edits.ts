/**
 * Applies a posture's edits to a harness home (harness-session-posture §4.7).
 *
 * A harness with no per-launch channel for a fact gets one narrow edit in its
 * own home: one vendor-documented key in a JSON file the harness owns, or one
 * file Podium owns outright. The home is shared with the harness itself and
 * with other sessions, so every edit is written to survive another writer:
 *
 * - Nothing is written when the home already holds the value.
 * - Edits to one file run one at a time across the whole daemon.
 * - A `json-key` edit reads the file, sets the one key, reads again and writes
 *   only if the file did not change in between, so a newer file is never
 *   replaced with an older copy. It writes beside the file and renames over it,
 *   then reads once more to check the key held. When another program won, the
 *   whole sequence runs once more, then the edit fails.
 * - A failed edit is an outcome, not an error: the caller reports it as an
 *   unmet requirement and the session still starts.
 *
 * There is no ledger and no undo: the edits are re-derived at every launch.
 */
import { randomBytes } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { HomeEdit } from '@podium/harness'

export type HomeEditOutcome =
  | { edit: HomeEdit; status: 'already' | 'applied' }
  | { edit: HomeEdit; status: 'failed'; reason: string }

export interface HomeEditPorts {
  /** The file's text, or `undefined` when it does not exist. Other errors throw. */
  readFile(path: string): Promise<string | undefined>
  /** Write beside the file and rename over it, creating its folder when missing. */
  writeFileAtomic(path: string, contents: string): Promise<void>
  /**
   * Create the file with `contents`, private to its owner, only if nothing is
   * at the path: `false` when something already is, which is left untouched.
   * Creates its folder when missing.
   */
  createFileExclusive(path: string, contents: string): Promise<boolean>
  log(message: string, fields: Record<string, unknown>): void
}

/** Attempts per edit: the first, and one retry when another program won. */
const ATTEMPTS = 2

/** The tail of the per-file queue: edits to one file run one at a time across the daemon. */
const fileQueues = new Map<string, Promise<unknown>>()

function serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
  const file = resolve(path)
  const previous = fileQueues.get(file) ?? Promise.resolve()
  const next = previous.then(run, run)
  const tail = next.then(
    () => {},
    () => {},
  )
  fileQueues.set(file, tail)
  void tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file)
  })
  return next
}

/** Apply each edit in order. Never rejects: a failure is a `failed` outcome. */
export async function applyHomeEdits(
  edits: readonly HomeEdit[],
  ports: HomeEditPorts,
): Promise<HomeEditOutcome[]> {
  const outcomes: HomeEditOutcome[] = []
  for (const edit of edits) {
    outcomes.push(await serialized(edit.file, () => applyOne(edit, ports)))
  }
  return outcomes
}

async function applyOne(edit: HomeEdit, ports: HomeEditPorts): Promise<HomeEditOutcome> {
  try {
    const result =
      edit.kind === 'json-key' ? await applyJsonKey(edit, ports) : await applyOwnedFile(edit, ports)
    if (result.status === 'applied') {
      ports.log('harness home edit applied', {
        kind: edit.kind,
        file: edit.file,
        ...(edit.kind === 'json-key' ? { key: [...edit.path] } : {}),
        serves: edit.serves,
      })
    }
    return result
  } catch (err) {
    return { edit, status: 'failed', reason: `could not edit ${edit.file}: ${errorMessage(err)}` }
  }
}

type JsonKeyEdit = Extract<HomeEdit, { kind: 'json-key' }>
type OwnedFileEdit = Extract<HomeEdit, { kind: 'owned-file' }>

async function applyOwnedFile(edit: OwnedFileEdit, ports: HomeEditPorts): Promise<HomeEditOutcome> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if ((await ports.readFile(edit.file)) === edit.contents) {
      return { edit, status: attempt === 0 ? 'already' : 'applied' }
    }
    await ports.writeFileAtomic(edit.file, edit.contents)
    if ((await ports.readFile(edit.file)) === edit.contents) return { edit, status: 'applied' }
  }
  return { edit, status: 'failed', reason: anotherWriter(edit.file) }
}

async function applyJsonKey(edit: JsonKeyEdit, ports: HomeEditPorts): Promise<HomeEditOutcome> {
  if (edit.path.length === 0) {
    return {
      edit,
      status: 'failed',
      reason: 'a json-key edit needs a key path; refusing to replace the whole file',
    }
  }
  let wrote = false
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const body = await ports.readFile(edit.file)
    if (body === undefined) {
      if (!edit.createIfMissing) {
        return {
          edit,
          status: 'failed',
          reason: `the harness has not created this file yet: ${edit.file}`,
        }
      }
      // A file in a home Podium owns: start it from an empty object. Created
      // exclusively, so a file the harness wrote in the meantime is never
      // replaced; the next attempt edits that file instead.
      const created = planJsonKey('{}', edit)
      if ('reason' in created || created.next === undefined) {
        return { edit, status: 'failed', reason: `could not plan a new ${edit.file}` }
      }
      if (await ports.createFileExclusive(edit.file, created.next)) {
        wrote = true
        const after = await ports.readFile(edit.file)
        if (after !== undefined && holdsValue(after, edit)) return { edit, status: 'applied' }
      }
      continue
    }
    const planned = planJsonKey(body, edit)
    if ('reason' in planned) return { edit, status: 'failed', reason: planned.reason }
    if (planned.next === undefined) return { edit, status: wrote ? 'applied' : 'already' }
    // Write only over the very file the edit was planned from: a body that
    // changed since is newer than our copy, and the next attempt starts from it.
    if ((await ports.readFile(edit.file)) !== body) continue
    await ports.writeFileAtomic(edit.file, planned.next)
    wrote = true
    const after = await ports.readFile(edit.file)
    if (after !== undefined && holdsValue(after, edit)) return { edit, status: 'applied' }
  }
  return { edit, status: 'failed', reason: anotherWriter(edit.file) }
}

function anotherWriter(file: string): string {
  return `another program kept writing ${file} while Podium edited it; gave up after ${ATTEMPTS} attempts`
}

/** The new body with the key set, `next: undefined` when the key already holds the value, or why it cannot be set. */
function planJsonKey(
  body: string,
  edit: JsonKeyEdit,
): { next: string | undefined } | { reason: string } {
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    return { reason: `${edit.file} is not JSON; left it untouched` }
  }
  if (!isObject(root))
    return { reason: `${edit.file} does not hold a JSON object; left it untouched` }
  const parents = edit.path.slice(0, -1)
  const leaf = edit.path[edit.path.length - 1] as string
  let node: Record<string, unknown> = root
  for (const [i, key] of parents.entries()) {
    const child = ownValue(node, key)
    if (child === undefined) {
      const created: Record<string, unknown> = {}
      setOwn(node, key, created)
      node = created
    } else if (isObject(child)) {
      node = child
    } else {
      return {
        reason: `${edit.file}: ${JSON.stringify(edit.path.slice(0, i + 1))} is not an object; left it untouched`,
      }
    }
  }
  if (jsonEqual(ownValue(node, leaf), edit.value)) return { next: undefined }
  setOwn(node, leaf, edit.value)
  return { next: serializeLike(body, root) }
}

function holdsValue(body: string, edit: JsonKeyEdit): boolean {
  let node: unknown
  try {
    node = JSON.parse(body)
  } catch {
    return false
  }
  for (const key of edit.path) {
    if (!isObject(node)) return false
    node = ownValue(node, key)
  }
  return jsonEqual(node, edit.value)
}

/** Serialize with the file's own indentation and trailing newline, so only the key's lines change. */
function serializeLike(original: string, value: unknown): string {
  const indent = /^[{[]\r?\n([ \t]+)\S/.exec(original)?.[1]
  const text = JSON.stringify(value, null, indent)
  const newline = /\r?\n$/.exec(original)?.[0] ?? ''
  return text + newline
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A key's own value: a path step such as `__proto__` is data, never the prototype. */
function ownValue(node: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(node, key) ? node[key] : undefined
}

function setOwn(node: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true })
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    )
  }
  return false
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The real filesystem. A write goes to a temporary file beside the target and
 * is renamed over it; a symlinked target (a dotfile manager's link) is written
 * through to the file it points at, and an existing file keeps its mode.
 */
export function nodeHomeEditPorts(log: HomeEditPorts['log']): HomeEditPorts {
  return {
    async readFile(path) {
      try {
        return await readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    },
    async writeFileAtomic(path, contents) {
      const target = await realpath(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return path
        throw err
      })
      const folder = dirname(target)
      await mkdir(folder, { recursive: true })
      const mode = await stat(target).then(
        (s) => s.mode & 0o777,
        () => undefined,
      )
      const temp = join(
        folder,
        `.${basename(target)}.podium-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
      )
      try {
        await writeFile(temp, contents, { encoding: 'utf8', mode: mode ?? 0o644, flag: 'wx' })
        if (mode !== undefined) await chmod(temp, mode)
        await rename(temp, target)
      } catch (err) {
        await rm(temp, { force: true })
        throw err
      }
    },
    async createFileExclusive(path, contents) {
      // Written in full beside the target, then hard-linked into place: the
      // link fails when anything is already at the path, so a file another
      // program created first is never replaced, and no reader ever sees a
      // half-written one.
      const folder = dirname(path)
      await mkdir(folder, { recursive: true })
      const temp = join(
        folder,
        `.${basename(path)}.podium-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
      )
      try {
        await writeFile(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await link(temp, path)
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      } finally {
        await rm(temp, { force: true })
      }
    },
    log,
  }
}
