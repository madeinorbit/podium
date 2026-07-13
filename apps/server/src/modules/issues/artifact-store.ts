import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Permanent artifact snapshot store ([spec:SP-0fc9] #441).
 *
 * At `artifact-add` time the server pulls the file bytes from the owning daemon
 * (existing readAsset RPC, chunked for large files) and snapshots them under
 * `<state-dir>/artifacts/<issueId>/<artifactId>/<relpath...>`, so artifacts
 * survive tmp cleanup / worktree deletion / the machine going offline. The
 * stored copy is immutable — re-adding the same source path mints a NEW
 * artifactId (new-id-then-swap keeps served URLs consistent with content).
 */

export const ARTIFACT_FILE_CAP_BYTES = 100 * 1024 * 1024
export const ARTIFACT_BUNDLE_CAP_BYTES = 500 * 1024 * 1024
export const ARTIFACT_FILE_COUNT_CAP = 200
/** Per-round-trip pull size — must stay under the daemon's MAX_ASSET_BYTES slice clamp. */
const PULL_CHUNK_BYTES = 4 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
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
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
}

export function artifactContentType(relPath: string): string {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

export interface ArtifactManifestFile {
  path: string
  size: number
}

export interface ArtifactSnapshot {
  artifactId: string
  entry: string
  files: ArtifactManifestFile[]
}

/** The two daemon RPCs the snapshotter rides (DaemonRpcService, structurally). */
export interface ArtifactRpc {
  readAsset(input: {
    machineId?: string
    root: string
    path: string
    offset?: number
    length?: number
  }): Promise<{
    ok: boolean
    dataBase64?: string
    contentType?: string
    tooLarge?: boolean
    size?: number
    error?: string
  }>
  listDir(input: { machineId?: string; root: string; path?: string }): Promise<{
    ok: boolean
    path: string
    entries: { name: string; isDir: boolean }[]
    error?: string
  }>
}

const ID_RE = /^[A-Za-z0-9._-]+$/

/** The added HTML/MD file (or the first file) is the bundle's primary entry. */
function pickEntry(relPaths: string[]): string {
  const primary = relPaths.find((p) => /\.(html?|md)$/i.test(p))
  return primary ?? relPaths[0] ?? ''
}

export class IssueArtifactStore {
  constructor(
    private readonly baseDir: string,
    private readonly rpc: ArtifactRpc,
  ) {}

  private artifactDir(issueId: string, artifactId: string): string {
    if (!ID_RE.test(issueId) || !ID_RE.test(artifactId)) throw new Error('bad artifact ref')
    return join(this.baseDir, issueId, artifactId)
  }

  /**
   * Snapshot the source path(s) into a fresh artifactId dir. A directory source
   * becomes a bundle (recursive walk via the daemon's sandboxed dir listing);
   * plain files land at their basename. Any pull/write failure removes the
   * partial dir and rethrows — nothing half-registered.
   */
  async snapshot(o: {
    issueId: string
    root: string
    machineId?: string
    sourcePath: string
    extraPaths?: string[]
  }): Promise<ArtifactSnapshot> {
    const artifactId = randomBytes(6).toString('hex')
    const dir = this.artifactDir(o.issueId, artifactId)
    const machine = o.machineId ? { machineId: o.machineId } : {}
    const abs = (p: string) => (isAbsolute(p) ? p : join(o.root, p))
    try {
      // Resolve the pull plan: [absolute source path, relpath inside the bundle].
      let plan: Array<{ src: string; rel: string }>
      const listed = await this.rpc.listDir({ ...machine, root: o.root, path: abs(o.sourcePath) })
      if (listed.ok) {
        plan = await this.walkDir(o.root, o.machineId, listed.path)
        if (plan.length === 0) throw new Error(`directory ${o.sourcePath} has no files`)
      } else {
        const paths = [o.sourcePath, ...(o.extraPaths ?? [])]
        plan = paths.map((p) => ({ src: abs(p), rel: p.split('/').pop() as string }))
      }
      if (plan.length > ARTIFACT_FILE_COUNT_CAP) {
        throw new Error(`artifact bundle has ${plan.length} files (cap ${ARTIFACT_FILE_COUNT_CAP})`)
      }
      let bundleBytes = 0
      const files: ArtifactManifestFile[] = []
      for (const { src, rel } of plan) {
        const size = await this.pullFile({ ...machine, root: o.root }, src, join(dir, rel))
        bundleBytes += size
        if (bundleBytes > ARTIFACT_BUNDLE_CAP_BYTES) {
          throw new Error(
            `artifact bundle exceeds ${ARTIFACT_BUNDLE_CAP_BYTES / (1024 * 1024)}MB at ${src}`,
          )
        }
        files.push({ path: rel, size })
      }
      return { artifactId, entry: pickEntry(files.map((f) => f.path)), files }
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /** Recursive sandboxed walk rooted at `dirAbs`; relpaths are relative to it. */
  private async walkDir(
    root: string,
    machineId: string | undefined,
    dirAbs: string,
  ): Promise<Array<{ src: string; rel: string }>> {
    const machine = machineId ? { machineId } : {}
    const out: Array<{ src: string; rel: string }> = []
    const pending: string[] = ['']
    while (pending.length) {
      const relDir = pending.shift() as string
      const absDir = relDir ? join(dirAbs, relDir) : dirAbs
      const r = await this.rpc.listDir({ ...machine, root, path: absDir })
      if (!r.ok) throw new Error(r.error ?? `cannot list ${absDir}`)
      for (const e of r.entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        if (e.isDir) pending.push(rel)
        else out.push({ src: join(dirAbs, rel), rel })
        if (out.length > ARTIFACT_FILE_COUNT_CAP) {
          throw new Error(`artifact bundle exceeds ${ARTIFACT_FILE_COUNT_CAP} files`)
        }
      }
    }
    return out
  }

  /** Chunked daemon pull of one file → durable local write. Returns byte size. */
  private async pullFile(
    target: { machineId?: string; root: string },
    srcAbs: string,
    destAbs: string,
  ): Promise<number> {
    this.assertInBase(destAbs)
    const chunks: Buffer[] = []
    let offset = 0
    let total: number | undefined
    do {
      const r = await this.rpc.readAsset({
        ...target,
        path: srcAbs,
        offset,
        length: PULL_CHUNK_BYTES,
      })
      if (!r.ok || r.dataBase64 == null) {
        throw new Error(`cannot read ${srcAbs}: ${r.error ?? 'read failed'}`)
      }
      total = r.size ?? Buffer.from(r.dataBase64, 'base64').length
      if (total > ARTIFACT_FILE_CAP_BYTES) {
        throw new Error(
          `${srcAbs} is ${total} bytes (per-file cap ${ARTIFACT_FILE_CAP_BYTES / (1024 * 1024)}MB)`,
        )
      }
      const buf = Buffer.from(r.dataBase64, 'base64')
      chunks.push(buf)
      offset += buf.length
      if (buf.length === 0 && offset < total) throw new Error(`short read pulling ${srcAbs}`)
    } while (offset < (total ?? 0))
    const bytes = Buffer.concat(chunks)
    await mkdir(dirname(destAbs), { recursive: true })
    const fh = await open(destAbs, 'w')
    try {
      await fh.writeFile(bytes)
      await fh.sync()
    } finally {
      await fh.close()
    }
    return bytes.length
  }

  /** Serve one stored file, traversal-guarded to the artifact dir. Null = 404. */
  async read(
    issueId: string,
    artifactId: string,
    relPath: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    let dir: string
    try {
      dir = this.artifactDir(issueId, artifactId)
    } catch {
      return null
    }
    const target = resolve(dir, relPath)
    if (target !== dir && !target.startsWith(dir + sep)) return null
    try {
      const st = await stat(target)
      if (!st.isFile()) return null
      return { bytes: await readFile(target), contentType: artifactContentType(target) }
    } catch {
      return null
    }
  }

  /** Delete one snapshot dir (artifact-remove / post-replace cleanup). */
  async remove(issueId: string, artifactId: string): Promise<void> {
    await rm(this.artifactDir(issueId, artifactId), { recursive: true, force: true })
  }

  /** Delete every snapshot of an issue (hard issue deletion). */
  async removeIssue(issueId: string): Promise<void> {
    if (!ID_RE.test(issueId)) return
    await rm(join(this.baseDir, issueId), { recursive: true, force: true })
  }

  private assertInBase(p: string): void {
    const resolved = resolve(p)
    if (!resolved.startsWith(resolve(this.baseDir) + sep)) throw new Error('path escapes store')
  }
}
