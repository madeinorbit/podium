import { constants } from 'node:fs'
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type {
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
} from '@podium/protocol'

const MAX_FILE_BYTES = 2 * 1024 * 1024

type ReadResult = Omit<FileReadResultMessage, 'type' | 'requestId'>
type WriteResult = Omit<FileWriteResultMessage, 'type' | 'requestId'>

/** True when `child` is `parent` or nested under it (no `..` escape). Both args
 *  must already be realpath-resolved by the caller. A name that merely starts
 *  with two dots (`..foo`) is a child like any other. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

const sig = (s: { mtimeMs: number; size: number }): string => `${s.mtimeMs}:${s.size}`

/**
 * THE SANDBOX ROOT, realpath-resolved, or the refusal (POD-7501).
 *
 * A request addressed by root names the registered repository the server
 * matched it to (`repoRoot`). The server's match is textual: a root such as
 * `<repo>/escape`, where `escape` is a symlink to `/`, sits under `<repo>` as
 * text. Only this machine can see what the root really is, so the root must
 * resolve to the repository or a folder inside it, both resolved here. A
 * session request carries no `repoRoot`: its sandbox is the session's own cwd.
 */
export async function sandboxRoot(
  root: string,
  repoRoot: string | undefined,
): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
  let real: string
  try {
    real = await realpath(root)
  } catch {
    return { ok: false, error: 'not found' }
  }
  if (repoRoot === undefined) return { ok: true, real }
  let realRepo: string
  try {
    realRepo = await realpath(repoRoot)
  } catch {
    return { ok: false, error: 'repository not found' }
  }
  return isInside(real, realRepo) ? { ok: true, real } : { ok: false, error: 'outside repository' }
}

/** Refuses to follow a symlink at the final component. 0 on Windows, which has no
 *  such flag; there the target was resolved just before. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
/** A FIFO planted where a file was would otherwise block the open until a writer
 *  came; non-blocking, the open returns and the fstat below refuses it. */
const O_NONBLOCK = constants.O_NONBLOCK ?? 0

/**
 * WHERE AN OPEN FILE REALLY IS, on Linux (POD-7503).
 *
 * The checks above resolve a path and then open it, and a folder along that path
 * can be swapped for a symlink in between. Linux names the opened file at
 * `/proc/self/fd/N`, so the check is repeated on what was actually opened. `null`
 * where the kernel offers no such name (other systems), `undefined` when Linux
 * could not say, which callers refuse.
 */
async function openedPath(fh: FileHandle): Promise<string | null | undefined> {
  if (process.platform !== 'linux') return null
  try {
    return await readlink(`/proc/self/fd/${fh.fd}`)
  } catch {
    return undefined
  }
}

/** Open `real` for reading without following a final link, and refuse anything but
 *  a regular file that, once open, still sits inside `sandbox` (unless `anywhere`). */
async function openForRead(
  real: string,
  sandbox: string,
  anywhere: boolean,
): Promise<{ ok: true; fh: FileHandle; size: number; sig: string } | { ok: false; error: string }> {
  let fh: FileHandle
  try {
    fh = await open(real, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return { ok: false, error: 'read error' }
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) {
      await fh.close()
      return { ok: false, error: 'not a file' }
    }
    if (!anywhere) {
      const at = await openedPath(fh)
      if (at === undefined || (at !== null && !isInside(at, sandbox))) {
        await fh.close()
        return { ok: false, error: 'outside workspace' }
      }
    }
    return { ok: true, fh, size: st.size, sig: sig(st) }
  } catch {
    await fh.close().catch(() => {})
    return { ok: false, error: 'read error' }
  }
}

export async function readFileSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
  /** The registered repository the server matched `cwd` to; see {@link sandboxRoot}. */
  repoRoot?: string
}): Promise<ReadResult> {
  const { cwd, path, repoRoot } = opts
  // The transcript-known exception belongs to a session; a repository root has none.
  const knownPath = opts.knownPath && repoRoot === undefined
  const sandbox = await sandboxRoot(cwd, repoRoot)
  if (!sandbox.ok) return { ok: false, path, error: sandbox.error }
  let real: string
  try {
    real = await realpath(path)
  } catch {
    return { ok: false, path, error: 'not found' }
  }
  if (!isInside(real, sandbox.real) && !knownPath)
    return { ok: false, path, error: 'outside workspace' }
  const opened = await openForRead(real, sandbox.real, knownPath)
  if (!opened.ok) return { ok: false, path, error: opened.error }
  const { fh } = opened
  try {
    if (opened.size > MAX_FILE_BYTES) return { ok: false, path, tooLarge: true }
    const buf = await fh.readFile()
    if (isBinary(buf)) return { ok: false, path, binary: true }
    return { ok: true, path, content: buf.toString('utf8'), baseHash: opened.sig }
  } catch {
    return { ok: false, path, error: 'read error' }
  } finally {
    await fh.close().catch(() => {})
  }
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024

const ASSET_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
}

type AssetResult = Omit<FileAssetResultMessage, 'type' | 'requestId'>

/** Read a (possibly binary) asset's bytes for the markdown preview, sandboxed to the
 *  session cwd exactly like readFileSandboxed. Returns base64 + a content-type.
 *  Ranged reads (`offset`+`length`) bypass the single-shot size cap
 *  so the server can pull large artifact files chunk by chunk; each slice is still
 *  clamped to MAX_ASSET_BYTES. `size` always reports the total file size. */
export async function readAssetSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
  repoRoot?: string
  offset?: number
  length?: number
}): Promise<AssetResult> {
  const { cwd, path, repoRoot } = opts
  const knownPath = opts.knownPath && repoRoot === undefined
  const sandbox = await sandboxRoot(cwd, repoRoot)
  if (!sandbox.ok) return { ok: false, path, error: sandbox.error }
  let real: string
  try {
    real = await realpath(path)
  } catch {
    return { ok: false, path, error: 'not found' }
  }
  if (!isInside(real, sandbox.real) && !knownPath)
    return { ok: false, path, error: 'outside workspace' }
  const opened = await openForRead(real, sandbox.real, knownPath)
  if (!opened.ok) return { ok: false, path, error: opened.error }
  const { fh, size } = opened
  try {
    let buf: Buffer
    if (opts.length != null) {
      const offset = opts.offset ?? 0
      const len = Math.min(opts.length, MAX_ASSET_BYTES, Math.max(0, size - offset))
      buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, offset)
      buf = buf.subarray(0, bytesRead)
    } else {
      if (size > MAX_ASSET_BYTES) return { ok: false, path, tooLarge: true, size }
      buf = await fh.readFile()
    }
    const ext = real.split('.').pop()?.toLowerCase() ?? ''
    // Unlisted extension: sniff rather than default to octet-stream. A .md, .ts or
    // .toml opened in a browser tab (the file viewer's Open in browser) should be
    // readable text; only actual binaries deserve the download fallback.
    const contentType =
      ASSET_CONTENT_TYPES[ext] ??
      (isBinary(buf) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
    return {
      ok: true,
      path,
      dataBase64: buf.toString('base64'),
      contentType,
      size,
    }
  } catch {
    return { ok: false, path, error: 'read error' }
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function writeFileSandboxed(opts: {
  cwd: string
  path: string
  content: string
  baseHash?: string
  repoRoot?: string
}): Promise<WriteResult> {
  const { cwd, path, content, baseHash, repoRoot } = opts
  const sandbox = await sandboxRoot(cwd, repoRoot)
  if (!sandbox.ok) return { ok: false, error: sandbox.error }
  let realDir: string
  try {
    realDir = await realpath(dirname(path))
  } catch {
    return { ok: false, error: 'not found' }
  }
  let real = join(realDir, basename(path))
  // The file itself may be a link: writing through `<repo>/x -> ~/.bashrc` would
  // land outside. Follow it here and judge where it points; a dangling link has
  // nowhere inside to point to, so it is refused.
  const link = await lstat(real).catch(() => null)
  if (link?.isSymbolicLink()) {
    try {
      real = await realpath(real)
    } catch {
      return { ok: false, error: 'outside workspace' }
    }
  }
  if (!isInside(real, sandbox.real)) return { ok: false, error: 'outside workspace' }
  const existed = link !== null
  let fh: FileHandle
  try {
    // No-follow: a link planted at `real` after the check is refused, not written
    // through. No O_TRUNC: nothing is cut until the opened file has been judged.
    // A file absent at the check is created exclusively, so the removal below
    // can only ever remove a file this open made.
    const create = existed ? constants.O_CREAT : constants.O_CREAT | constants.O_EXCL
    fh = await open(real, constants.O_WRONLY | create | O_NOFOLLOW | O_NONBLOCK, 0o666)
  } catch {
    return { ok: false, error: 'write error' }
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return { ok: false, error: 'not a file' }
    // A hard link resolves to its own name, so realpath says nothing about it:
    // `<repo>/x` hard-linked to `~/.bashrc` is the same file. One that has another
    // name anywhere is refused rather than rewritten under all of them.
    if (st.nlink > 1) return { ok: false, error: 'file has other hard links' }
    const at = await openedPath(fh)
    if (at === undefined || (at !== null && !isInside(at, sandbox.real))) {
      // A folder along the path was swapped after the check; a file this open just
      // created there is removed again (by the name the kernel gave it).
      if (!existed && at) await unlink(at).catch(() => {})
      return { ok: false, error: 'outside workspace' }
    }
    if (baseHash && existed && sig(st) !== baseHash) return { ok: false, conflict: true }
    await fh.truncate(0)
    await fh.writeFile(content, 'utf8')
    return { ok: true, baseHash: sig(await fh.stat()) }
  } catch {
    return { ok: false, error: 'write error' }
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function listDirSandboxed(opts: {
  root: string
  path?: string
  repoRoot?: string
}): Promise<{
  ok: boolean
  path: string
  entries: { name: string; isDir: boolean }[]
  error?: string
}> {
  const target = opts.path ?? opts.root
  // Every listing is root-addressed, so it names its repository (POD-7503). A
  // frame without one comes from a server that predates the check; listing its
  // root unchecked would follow a symlinked root anywhere.
  if (opts.repoRoot === undefined)
    return { ok: false, path: target, entries: [], error: 'repository root required' }
  const sandbox = await sandboxRoot(opts.root, opts.repoRoot)
  if (!sandbox.ok) return { ok: false, path: target, entries: [], error: sandbox.error }
  const realRoot = sandbox.real
  let real: string
  try {
    real = await realpath(target)
  } catch {
    return { ok: false, path: target, entries: [], error: 'not found' }
  }
  if (!isInside(real, realRoot))
    return { ok: false, path: target, entries: [], error: 'outside workspace' }
  try {
    const st = await stat(real)
    if (!st.isDirectory()) return { ok: false, path: real, entries: [], error: 'not a directory' }
    const entries = (await readdir(real, { withFileTypes: true }))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    return { ok: true, path: real, entries }
  } catch {
    return { ok: false, path: real, entries: [], error: 'read error' }
  }
}
