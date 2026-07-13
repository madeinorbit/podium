import { open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
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

export async function readFileSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
}): Promise<ReadResult> {
  const { cwd, path, knownPath } = opts
  let realCwd: string
  let real: string
  try {
    realCwd = await realpath(cwd)
    real = await realpath(path)
  } catch {
    return { ok: false, path, error: 'not found' }
  }
  if (!isInside(real, realCwd) && !knownPath) return { ok: false, path, error: 'outside workspace' }
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
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}

type AssetResult = Omit<FileAssetResultMessage, 'type' | 'requestId'>

/** Read a (possibly binary) asset's bytes for the markdown preview, sandboxed to the
 *  session cwd exactly like readFileSandboxed. Returns base64 + a content-type.
 *  Ranged reads (`offset`+`length`, [spec:SP-0fc9]) bypass the single-shot size cap
 *  so the server can pull large artifact files chunk by chunk; each slice is still
 *  clamped to MAX_ASSET_BYTES. `size` always reports the total file size. */
export async function readAssetSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
  offset?: number
  length?: number
}): Promise<AssetResult> {
  const { cwd, path, knownPath } = opts
  let realCwd: string
  let real: string
  try {
    realCwd = await realpath(cwd)
    real = await realpath(path)
  } catch {
    return { ok: false, path, error: 'not found' }
  }
  if (!isInside(real, realCwd) && !knownPath) return { ok: false, path, error: 'outside workspace' }
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
        await fh.read(buf, 0, len, offset)
      } finally {
        await fh.close()
      }
    } else {
      if (st.size > MAX_ASSET_BYTES) return { ok: false, path, tooLarge: true, size: st.size }
      buf = await readFile(real)
    }
    const ext = real.split('.').pop()?.toLowerCase() ?? ''
    return {
      ok: true,
      path,
      dataBase64: buf.toString('base64'),
      contentType: ASSET_CONTENT_TYPES[ext] ?? 'application/octet-stream',
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
}): Promise<WriteResult> {
  const { cwd, path, content, baseHash } = opts
  let realCwd: string
  let realDir: string
  try {
    realCwd = await realpath(cwd)
    realDir = await realpath(dirname(path))
  } catch {
    return { ok: false, error: 'not found' }
  }
  const real = join(realDir, basename(path))
  if (!isInside(real, realCwd)) return { ok: false, error: 'outside workspace' }
  if (baseHash) {
    const current = await stat(real)
      .then(sig)
      .catch(() => null)
    if (current && current !== baseHash) return { ok: false, conflict: true }
  }
  try {
    await writeFile(real, content, 'utf8')
    const st = await stat(real)
    return { ok: true, baseHash: sig(st) }
  } catch {
    return { ok: false, error: 'write error' }
  }
}

export async function listDirSandboxed(opts: { root: string; path?: string }): Promise<{
  ok: boolean
  path: string
  entries: { name: string; isDir: boolean }[]
  error?: string
}> {
  const target = opts.path ?? opts.root
  let realRoot: string
  let real: string
  try {
    realRoot = await realpath(opts.root)
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
