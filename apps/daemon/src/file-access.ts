import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { FileAssetResultMessage, FileReadResultMessage, FileWriteResultMessage } from '@podium/protocol'

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
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon',
}

type AssetResult = Omit<FileAssetResultMessage, 'type' | 'requestId'>

/** Read a (possibly binary) asset's bytes for the markdown preview, sandboxed to the
 *  session cwd exactly like readFileSandboxed. Returns base64 + a content-type. */
export async function readAssetSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
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
    if (st.size > MAX_ASSET_BYTES) return { ok: false, path, tooLarge: true }
    const buf = await readFile(real)
    const ext = real.split('.').pop()?.toLowerCase() ?? ''
    return {
      ok: true,
      path,
      dataBase64: buf.toString('base64'),
      contentType: ASSET_CONTENT_TYPES[ext] ?? 'application/octet-stream',
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
