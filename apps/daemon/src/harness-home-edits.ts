/**
 * Applies a posture's edits to a harness home (harness-session-posture §4.7).
 *
 * A harness with no per-launch channel for a fact gets one narrow edit in its
 * own home: one vendor-documented key in a JSON file the harness owns, one
 * string added to a vendor-documented array in a TOML file the harness owns,
 * or one file Podium owns outright. The home is shared with the harness itself
 * and with other sessions, so every edit is written to survive another writer:
 *
 * - Nothing is written when the home already holds the value.
 * - Edits to one file run one at a time across the whole daemon.
 * - A `json-key` or `toml-array-entry` edit reads the file, sets the one key
 *   (or adds the one array entry, every other line kept), reads again and
 *   writes only if the file did not change in between, so a newer file is
 *   never replaced with an older copy. It writes beside the file and renames
 *   over it, then reads once more to check the value held. When another
 *   program won, the whole sequence runs once more, then the edit fails.
 * - A failed edit is an outcome, not an error: the caller reports it as an
 *   unmet requirement and the session still starts.
 *
 * Applied edits in a person's home keep their prior value in the install
 * ledger. Edits in Podium homes disappear with the home and need no record.
 *
 * The hook installs of the Codex and Grok instrumentation write their own
 * shared hook files; {@link recordHookFile} puts those in the same ledger, and
 * undo takes out exactly Podium's handlers again (POD-7388).
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { HomeEdit, InstrumentationHookFile, JsonValue } from '@podium/harness'
import type { HomeEditRecord, StoredHomeEdit } from '@podium/harness/inventory'
import {
  planTomlArrayEntry,
  planTomlArrayEntryRemoval,
  tomlArrayHolds,
} from './harness-home-toml.js'

export type HomeEditOutcome =
  | { edit: HomeEdit; status: 'already' | 'applied' }
  | { edit: HomeEdit; status: 'failed'; reason: string }

export interface HomeEditPorts {
  /** Follow links, including the existing parents of a file not created yet. */
  realPath?(path: string): Promise<string>
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

export interface HomeEditRecorder {
  harness: HomeEditRecord['harness']
  record(record: HomeEditRecord): void | Promise<void>
}

export interface HomeEditLedger {
  homeEdits(harness?: HomeEditRecord['harness']): StoredHomeEdit[]
  removeHomeEdit(id: number): void
}

export interface HomeEditRecordingLedger {
  homeEdits(harness?: HomeEditRecord['harness']): StoredHomeEdit[]
  recordHomeEdit(record: HomeEditRecord): StoredHomeEdit
}

export interface HomeEditUndoPorts extends HomeEditPorts {
  removeFile(path: string): Promise<void>
}

export type HomeEditUndoOutcome =
  | { record: StoredHomeEdit; status: 'restored' }
  | { record: StoredHomeEdit; status: 'changed' | 'failed'; reason: string }

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
  recorder?: HomeEditRecorder,
): Promise<HomeEditOutcome[]> {
  const outcomes: HomeEditOutcome[] = []
  for (const edit of edits) {
    try {
      if (recorder && !ports.realPath) throw new Error('home edit recording needs a real path')
      const file = (await ports.realPath?.(edit.file)) ?? edit.file
      const result = await serialized(file, () => applyOne({ ...edit, file }, ports, recorder))
      outcomes.push({ ...result, edit })
    } catch (err) {
      outcomes.push({
        edit,
        status: 'failed',
        reason: `could not edit ${edit.file}: ${errorMessage(err)}`,
      })
    }
  }
  return outcomes
}

async function applyOne(
  edit: HomeEdit,
  ports: HomeEditPorts,
  recorder?: HomeEditRecorder,
): Promise<HomeEditOutcome> {
  try {
    let prior: HomeEditRecord['prior'] | undefined
    const beforeWrite = (body: string | undefined) => {
      prior ??= priorValue(edit, body)
    }
    const result =
      edit.kind === 'owned-file'
        ? await applyOwnedFile(edit, ports, beforeWrite)
        : await applyKeyed(edit, ports, beforeWrite)
    if (result.status === 'applied') {
      if (recorder && prior) {
        await recorder.record({
          harness: recorder.harness,
          file: edit.file,
          edit:
            edit.kind === 'owned-file'
              ? { kind: edit.kind, sha256: sha256(edit.contents) }
              : edit.kind === 'json-key'
                ? { kind: edit.kind, path: [...edit.path], value: edit.value }
                : { kind: edit.kind, path: [...edit.path], value: edit.value },
          prior,
          serves: edit.serves,
          appliedAt: new Date().toISOString(),
        })
      }
      ports.log('harness home edit applied', {
        kind: edit.kind,
        file: edit.file,
        ...(edit.kind === 'owned-file' ? {} : { key: [...edit.path] }),
        serves: edit.serves,
      })
    }
    return result
  } catch (err) {
    return { edit, status: 'failed', reason: `could not edit ${edit.file}: ${errorMessage(err)}` }
  }
}

type JsonKeyEdit = Extract<HomeEdit, { kind: 'json-key' }>
type TomlArrayEntryEdit = Extract<HomeEdit, { kind: 'toml-array-entry' }>
type OwnedFileEdit = Extract<HomeEdit, { kind: 'owned-file' }>

async function applyOwnedFile(
  edit: OwnedFileEdit,
  ports: HomeEditPorts,
  beforeWrite: (body: string | undefined) => void,
): Promise<HomeEditOutcome> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const body = await ports.readFile(edit.file)
    if (body === edit.contents) {
      return { edit, status: attempt === 0 ? 'already' : 'applied' }
    }
    beforeWrite(body)
    await ports.writeFileAtomic(edit.file, edit.contents)
    if ((await ports.readFile(edit.file)) === edit.contents) return { edit, status: 'applied' }
  }
  return { edit, status: 'failed', reason: anotherWriter(edit.file) }
}

/** How a keyed edit reads and changes its file's format. */
interface KeyedFormat {
  /** The body a missing file is planned from. */
  empty: string
  /** The new body, `next: undefined` when the file already holds the value, or why not. */
  plan(body: string): { next: string | undefined } | { reason: string }
  holds(body: string): boolean
}

function keyedFormat(edit: JsonKeyEdit | TomlArrayEntryEdit): KeyedFormat {
  if (edit.kind === 'json-key') {
    const json: JsonKeyEdit = edit
    return {
      empty: '{}',
      plan: (body) => planJsonKey(body, json),
      holds: (body) => holdsValue(body, json),
    }
  }
  const { file, path, value } = edit
  return {
    empty: '',
    plan: (body) => {
      const planned = planTomlArrayEntry(body, path, value)
      return 'reason' in planned ? { reason: `${file}: ${planned.reason}` } : planned
    },
    holds: (body) => tomlArrayHolds(body, path, value),
  }
}

async function applyKeyed(
  edit: JsonKeyEdit | TomlArrayEntryEdit,
  ports: HomeEditPorts,
  beforeWrite: (body: string | undefined) => void,
): Promise<HomeEditOutcome> {
  if (edit.path.length === 0) {
    return {
      edit,
      status: 'failed',
      reason: `a ${edit.kind} edit needs a key path; refusing to replace the whole file`,
    }
  }
  const format = keyedFormat(edit)
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
      // A file in a home Podium owns: start it from an empty document.
      // Created exclusively, so a file the harness wrote in the meantime is
      // never replaced; the next attempt edits that file instead.
      const created = format.plan(format.empty)
      if ('reason' in created || created.next === undefined) {
        return { edit, status: 'failed', reason: `could not plan a new ${edit.file}` }
      }
      if (await ports.createFileExclusive(edit.file, created.next)) {
        beforeWrite(undefined)
        wrote = true
        const after = await ports.readFile(edit.file)
        if (after !== undefined && format.holds(after)) return { edit, status: 'applied' }
      }
      continue
    }
    const planned = format.plan(body)
    if ('reason' in planned) return { edit, status: 'failed', reason: planned.reason }
    if (planned.next === undefined) return { edit, status: wrote ? 'applied' : 'already' }
    // Write only over the very file the edit was planned from: a body that
    // changed since is newer than our copy, and the next attempt starts from it.
    if ((await ports.readFile(edit.file)) !== body) continue
    beforeWrite(body)
    await ports.writeFileAtomic(edit.file, planned.next)
    wrote = true
    const after = await ports.readFile(edit.file)
    if (after !== undefined && format.holds(after)) return { edit, status: 'applied' }
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

function holdsValue(body: string, edit: Pick<JsonKeyEdit, 'path' | 'value'>): boolean {
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

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function jsonKeyValue(body: string, path: readonly string[]): unknown {
  let node: unknown = JSON.parse(body)
  for (const key of path) {
    if (!isObject(node)) return undefined
    node = ownValue(node, key)
  }
  return node
}

function priorValue(edit: HomeEdit, body: string | undefined): HomeEditRecord['prior'] {
  if (edit.kind === 'owned-file') {
    return body === undefined ? { absent: true } : { contents: body }
  }
  if (body === undefined || edit.kind === 'toml-array-entry') return { absent: true }
  const value = jsonKeyValue(body, edit.path)
  return value === undefined ? { absent: true } : { value: value as JsonValue }
}

/** List and undo share the ledger's records; conflicts stay recorded for review/retry. */
export async function undoHomeEdits(
  ledger: HomeEditLedger,
  ports: HomeEditUndoPorts,
  harness?: HomeEditRecord['harness'],
): Promise<HomeEditUndoOutcome[]> {
  const outcomes: HomeEditUndoOutcome[] = []
  for (const record of ledger.homeEdits(harness)) {
    outcomes.push(
      await serialized<HomeEditUndoOutcome>(record.file, async () => {
        try {
          // The record names the file originally written, not a dotfile link
          // that may since have been pointed at a different file.
          if (ports.realPath && (await ports.realPath(record.file)) !== record.file) {
            return {
              record,
              status: 'changed',
              reason: 'the recorded path now points elsewhere; left it untouched',
            }
          }
          for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            const body = await ports.readFile(record.file)
            const planned = planUndo(record, body)
            if ('reason' in planned) return { record, status: 'changed', reason: planned.reason }
            if ('gone' in planned) {
              // Nothing of Podium's is left in the file: only the record goes.
              ledger.removeHomeEdit(record.id)
              return { record, status: 'restored' }
            }
            if ((await ports.readFile(record.file)) !== body) continue
            if (planned.next === undefined) await ports.removeFile(record.file)
            else await ports.writeFileAtomic(record.file, planned.next)
            if ((await ports.readFile(record.file)) === planned.next) {
              ledger.removeHomeEdit(record.id)
              return { record, status: 'restored' }
            }
          }
          return { record, status: 'failed', reason: anotherWriter(record.file) }
        } catch (err) {
          return { record, status: 'failed', reason: errorMessage(err) }
        }
      }),
    )
  }
  return outcomes
}

function planUndo(
  record: HomeEditRecord,
  body: string | undefined,
): { next: string | undefined } | { reason: string } | { gone: true } {
  const changed = { reason: 'the file no longer holds Podium’s value; left it untouched' }
  const { edit, prior } = record
  if (edit.kind === 'hook-handlers')
    return planHookHandlersUndo(record.file, edit.marker, prior, body)
  if (body === undefined) return changed
  if (edit.kind === 'owned-file') {
    if (sha256(body) !== edit.sha256) return changed
    if ('absent' in prior) return { next: undefined }
    if ('contents' in prior) return { next: prior.contents }
    throw new Error('an owned-file record needs prior contents or absence')
  }
  if (edit.kind === 'toml-array-entry') {
    if (!tomlArrayHolds(body, edit.path, edit.value)) return changed
    return planTomlArrayEntryRemoval(body, edit.path, edit.value)
  }
  if (edit.path.length === 0 || !holdsValue(body, edit)) return changed
  const root: unknown = JSON.parse(body)
  let node = root as Record<string, unknown>
  for (const key of edit.path.slice(0, -1)) node = ownValue(node, key) as Record<string, unknown>
  const leaf = edit.path[edit.path.length - 1] as string
  if ('absent' in prior) delete node[leaf]
  else if ('value' in prior) setOwn(node, leaf, prior.value)
  else throw new Error('a json-key record needs a prior value or absence')
  return { next: serializeLike(body, root) }
}

/**
 * Undo Podium's hook handlers: take out every handler whose command holds the
 * marker, and the groups, event lists and `hooks` object only those handlers
 * filled. Everything else in the file stays, including hooks added since. The
 * file goes back to its exact bytes from before Podium's first write when the
 * rest of it is unchanged, and is removed when Podium created it and nothing
 * else is in it now.
 */
function planHookHandlersUndo(
  file: string,
  marker: string,
  prior: HomeEditRecord['prior'],
  body: string | undefined,
): { next: string | undefined } | { reason: string } | { gone: true } {
  if (body === undefined) return { gone: true }
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    return { reason: `${file} is not JSON any more; left it untouched` }
  }
  if (!isObject(root)) return { reason: `${file} does not hold a JSON object; left it untouched` }
  const stripped = withoutHookHandlers(root, marker)
  if (stripped.removed === 0) return { gone: true }
  let priorRest: Record<string, unknown> | undefined
  if ('contents' in prior) {
    let priorRoot: unknown
    try {
      priorRoot = JSON.parse(prior.contents)
    } catch {
      priorRoot = undefined
    }
    if (isObject(priorRoot)) {
      const priorStripped = withoutHookHandlers(priorRoot, marker)
      if (priorStripped.removed === 0 && jsonEqual(priorRoot, stripped.root)) {
        return { next: prior.contents }
      }
      priorRest = priorStripped.root
    }
  } else if (!('absent' in prior)) {
    throw new Error('a hook-handlers record needs prior contents or absence')
  }
  const empty = Object.keys(stripped.root).length === 0
  if (empty && (priorRest === undefined || Object.keys(priorRest).length === 0)) {
    return { next: undefined }
  }
  return { next: serializeLike(body, stripped.root) }
}

/** The document without the handlers whose command holds `marker`, and how many there were. */
function withoutHookHandlers(
  root: Record<string, unknown>,
  marker: string,
): { root: Record<string, unknown>; removed: number } {
  const hooks = ownValue(root, 'hooks')
  if (!isObject(hooks)) return { root, removed: 0 }
  let removed = 0
  const nextHooks: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      setOwn(nextHooks, event, groups)
      continue
    }
    let removedHere = 0
    const kept: unknown[] = []
    for (const group of groups) {
      const handlers = isObject(group) ? ownValue(group, 'hooks') : undefined
      if (!isObject(group) || !Array.isArray(handlers)) {
        kept.push(group)
        continue
      }
      const left = handlers.filter(
        (handler) =>
          !(
            isObject(handler) &&
            typeof handler.command === 'string' &&
            handler.command.includes(marker)
          ),
      )
      if (left.length === handlers.length) {
        kept.push(group)
        continue
      }
      removedHere += handlers.length - left.length
      // A group Podium added holds only its handler; one with more keys is the person's.
      if (left.length === 0 && Object.keys(group).every((key) => key === 'hooks')) continue
      kept.push({ ...group, hooks: left })
    }
    removed += removedHere
    if (removedHere > 0 && kept.length === 0) continue
    setOwn(nextHooks, event, kept)
  }
  if (removed === 0) return { root, removed }
  const next: Record<string, unknown> = { ...root }
  if (Object.keys(nextHooks).length === 0) delete next.hooks
  else setOwn(next, 'hooks', nextHooks)
  return { root: next, removed }
}

/**
 * Record Podium's handlers in a hook file in the person's own folder.
 *
 * The prior is the file before this install wrote it. When the install wrote
 * nothing and no record exists yet (handlers an older Podium put there), it is
 * the file as it is without Podium's handlers: absent when nothing else is in
 * it. A second record of the same file keeps the first prior.
 */
export async function recordHookFile(
  harness: HomeEditRecord['harness'],
  hookFile: InstrumentationHookFile,
  ports: Pick<HomeEditPorts, 'readFile'> & { realPath(path: string): Promise<string> },
  ledger: HomeEditRecordingLedger,
): Promise<StoredHomeEdit | undefined> {
  const file = await ports.realPath(hookFile.file)
  const recorded = ledger
    .homeEdits(harness)
    .find(
      (record) =>
        record.file === file &&
        record.edit.kind === 'hook-handlers' &&
        record.edit.marker === hookFile.marker,
    )
  if (recorded && !hookFile.prior) return recorded
  let prior: HomeEditRecord['prior'] | undefined = hookFile.prior
  if (!prior) {
    const body = await ports.readFile(file)
    if (body === undefined) return undefined
    let root: unknown
    try {
      root = JSON.parse(body)
    } catch {
      return undefined
    }
    if (!isObject(root)) return undefined
    const stripped = withoutHookHandlers(root, hookFile.marker)
    if (stripped.removed === 0) return undefined
    prior =
      Object.keys(stripped.root).length === 0
        ? { absent: true }
        : { contents: serializeLike(body, stripped.root) }
  }
  return ledger.recordHomeEdit({
    harness,
    file,
    edit: { kind: 'hook-handlers', marker: hookFile.marker, events: [...hookFile.events] },
    prior,
    serves: 'session-state',
    appliedAt: new Date().toISOString(),
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The real filesystem. A write goes to a temporary file beside the target and
 * is renamed over it; a symlinked target (a dotfile manager's link) is written
 * through to the file it points at, and an existing file keeps its mode.
 */
export function nodeHomeEditPorts(log: HomeEditPorts['log']): HomeEditUndoPorts & {
  realPath(path: string): Promise<string>
} {
  return {
    realPath: realHomeEditPath,
    async removeFile(path) {
      await rm(path)
    },
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

/** Resolve existing links even when the target file or its last parents are absent. */
async function realHomeEditPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const linked = await readlink(absolute).catch((linkError: NodeJS.ErrnoException) => {
      if (linkError.code === 'ENOENT' || linkError.code === 'EINVAL') return undefined
      throw linkError
    })
    if (linked !== undefined) return realHomeEditPath(resolve(dirname(absolute), linked))
    // realpath on a missing leaf loses symlinked parent information. Resolve
    // upwards until an existing ancestor supplies it.
    const parent = dirname(absolute)
    if (parent === absolute) throw err
    return join(await realHomeEditPath(parent), basename(absolute))
  }
}
