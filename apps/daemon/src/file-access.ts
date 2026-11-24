import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type {
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
} from '@podium/protocol'

const MAX_FILE_BYTES = 2 * 1024 * 1024

type ReadResult = Omit<FileReadResultMessage, 'type' | 'requestId'>
type WriteResult = Omit<FileWriteResultMessage, 'type' | 'requestId'>

/** True when `child` is `parent` or nested under it (no `..` escape). Both args
 *  must already be realpath-resolved by the caller. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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
async function sandboxRoot(
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

/** Refuses to follow a symlink at the final component when opening for write. 0 on
 *  Windows, which has no such flag; there the target was resolved just before. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

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
  try {
    const st = await stat(real)
    if (!st.isFile()) return { ok: false, path, error: 'not a file' }
    if (st.size > MAX_FILE_BYTES) return { ok: false, path, tooLarge: true }
    const buf = await readFile(real)
    if (isBinary(buf)) return { ok: false, path, binary: true }
    return { ok: true, path, content: buf.toString('utf8'), baseHash: sig(st) }
  } catch {
    return { ok: false, path, error: 'read error' }
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
  try {
    const st = await stat(real)
    if (!st.isFile()) return { ok: false, path, error: 'not a file' }
    let buf: Buffer
    if (opts.length != null) {
      const offset = opts.offset ?? 0
      const len = Math.min(opts.length, MAX_ASSET_BYTES, Math.max(0, st.size - offset))
      buf = Buffer.alloc(len)
      const fh = await open(real, 'r')
      try {
        const { bytesRead } = await fh.read(buf, 0, len, offset)
        buf = buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    } else {
      if (st.size > MAX_ASSET_BYTES) return { ok: false, path, tooLarge: true, size: st.size }
      buf = await readFile(real)
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
      size: st.size,
    }
  } catch {
    return { ok: false, path, error: 'read error' }
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
  if (baseHash) {
    const current = await stat(real)
      .then(sig)
      .catch(() => null)
    if (current && current !== baseHash) return { ok: false, conflict: true }
  }
  try {
    // No-follow: a link planted at `real` after the check is refused, not written through.
    const fh = await open(
      real,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
      0o666,
    )
    try {
      await fh.writeFile(content, 'utf8')
    } finally {
      await fh.close()
    }
    const st = await stat(real)
    return { ok: true, baseHash: sig(st) }
  } catch {
    return { ok: false, error: 'write error' }
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
