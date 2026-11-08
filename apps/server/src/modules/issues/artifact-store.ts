import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  ARTIFACT_BUNDLE_CAP_BYTES,
  ARTIFACT_FILE_CAP_BYTES,
  ARTIFACT_FILE_COUNT_CAP,
  ARTIFACT_UPLOAD_CHUNK_BYTES,
  type ArtifactId,
  ArtifactUploadPacket,
  asArtifactId,
  type IssueId,
  joinMachinePath,
  type MachineId,
  machinePathBasename,
  machinePathSeparator,
  normalizeMachinePath,
  resolveMachinePath,
} from '@podium/model'
import type { PortableStateWriteFence } from '../server-transfer/portable-fence'

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
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
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
  artifactId: ArtifactId
  entry: string
  files: ArtifactManifestFile[]
  /** Worktree-relative source files this snapshot captured. */
  sourcePaths: string[]
}

export interface ArtifactSnapshotInput {
  issueId: IssueId
  root: string
  machineId?: MachineId
  sourcePath: string
  extraPaths?: string[]
  /**
   * The id to snapshot under (an effect record's, POD-6420): a run of the same
   * record pulls again into the same dir, replacing what a crashed run left.
   * Absent: a fresh id.
   */
  artifactId?: ArtifactId
}

/** A staged CLI upload published as an artifact. */
export interface PublishedUpload {
  snapshot: ArtifactSnapshot
  path: string
  title?: string
}

export interface ArtifactUploadInput {
  issueId: IssueId
  filename: string
  dataBase64: string
}

/** The two daemon RPCs the snapshotter rides (DaemonRpcService, structurally). */
export interface ArtifactRpc {
  readAsset(input: {
    machineId?: MachineId
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
  listDir(input: { machineId?: MachineId; root: string; path?: string }): Promise<{
    ok: boolean
    path: string
    entries: { name: string; isDir: boolean }[]
    error?: string
  }>
}

// Dot-prefixed directories are private staging, never public artifact refs.
const ID_RE = /^(?!\.)[A-Za-z0-9._-]+$/

/** The added HTML/MD file (or the first file) is the bundle's primary entry. */
function pickEntry(relPaths: string[]): string {
  const primary = relPaths.find((p) => /\.(html?|md)$/i.test(p))
  return primary ?? relPaths[0] ?? ''
}

export class IssueArtifactStore {
  private readonly uploadLocks = new Map<string, Promise<void>>()
  constructor(
    private readonly baseDir: string,
    private readonly rpc: ArtifactRpc,
    private readonly writeFence?: PortableStateWriteFence,
  ) {}

  private artifactDir(issueId: IssueId, artifactId: ArtifactId): string {
    if (!ID_RE.test(issueId) || !ID_RE.test(artifactId)) throw new Error('bad artifact ref')
    return join(this.baseDir, issueId, artifactId)
  }

  /** Bounded packets let CLI files cross the agent relay without lifting its
   * request cap. Incomplete uploads never appear in the issue panel. */
  async transfer(
    issueId: IssueId,
    raw: ArtifactUploadPacket,
  ): Promise<{ snapshot: ArtifactSnapshot; path: string; title?: string } | undefined> {
    const packet = ArtifactUploadPacket.parse(raw)
    if (!ID_RE.test(issueId)) throw new Error('bad issue ref')
    const key = `${issueId}/${packet.uploadId}`
    const previous = this.uploadLocks.get(key)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    this.uploadLocks.set(key, held)
    await previous
    const dir = join(this.baseDir, '.uploads', issueId, packet.uploadId)
    try {
      const write = async () => await this.transferWritable(issueId, dir, packet)
      return this.writeFence ? await this.writeFence.runWriter(write) : await write()
    } finally {
      release()
      if (this.uploadLocks.get(key) === held) this.uploadLocks.delete(key)
    }
  }

  private async transferWritable(issueId: IssueId, dir: string, packet: ArtifactUploadPacket) {
    if (packet.action === 'abort') {
      await rm(dir, { recursive: true, force: true })
      return
    }
    if (packet.action === 'begin') {
      const paths = new Set<string>()
      for (const file of packet.files) {
        if (
          file.path.includes('\\') ||
          file.path.includes('\0') ||
          /^[A-Za-z]:/.test(file.path) ||
          file.path
            .split('/')
            .some(
              (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                /[<>:"|?*]/.test(part) ||
                [...part].some((char) => char.charCodeAt(0) < 32) ||
                /[. ]$/.test(part) ||
                /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
            )
        ) {
          throw new Error('artifact members must have relative paths without traversal')
        }
        if (paths.has(file.path)) throw new Error('duplicate artifact member')
        paths.add(file.path)
      }
      if (!paths.has(packet.entry)) throw new Error('artifact entry must name a bundle member')
      if (packet.files.reduce((sum, file) => sum + file.size, 0) > ARTIFACT_BUNDLE_CAP_BYTES) {
        throw new Error('artifact bundle exceeds 500MB')
      }
      await mkdir(join(dir, 'files'), { recursive: true })
      // Exclusive creation prevents a retry or competing sender from resetting
      // an upload whose chunks have already arrived.
      await writeFile(join(dir, 'meta.json'), JSON.stringify(packet), { flag: 'wx' })
      try {
        for (const file of packet.files) {
          const target = join(dir, 'files', file.path)
          await mkdir(dirname(target), { recursive: true })
          const fh = await open(target, 'wx')
          await fh.close()
        }
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        throw error
      }
      return
    }
    const meta = ArtifactUploadPacket.parse(
      JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')),
    )
    if (meta.action !== 'begin') throw new Error('invalid artifact upload metadata')
    if (packet.action === 'chunk') {
      const file = meta.files.find((file) => file.path === packet.file)
      if (!file) throw new Error('unknown artifact member')
      const bytes = Buffer.from(packet.dataBase64, 'base64')
      if (
        bytes.toString('base64') !== packet.dataBase64 ||
        bytes.length > ARTIFACT_UPLOAD_CHUNK_BYTES
      ) {
        throw new Error('invalid artifact chunk')
      }
      const target = join(dir, 'files', file.path)
      const size = (await stat(target)).size
      if (packet.offset + bytes.length > file.size || packet.offset > size) {
        throw new Error('artifact chunk exceeds the declared size or skips bytes')
      }
      const fh = await open(target, 'r+')
      try {
        if (packet.offset < size) {
          const existing = Buffer.alloc(bytes.length)
          const read = await fh.read(existing, 0, bytes.length, packet.offset)
          if (read.bytesRead !== bytes.length || !existing.equals(bytes)) {
            throw new Error('artifact chunk conflicts with previously uploaded bytes')
          }
        } else {
          let written = 0
          while (written < bytes.length) {
            const result = await fh.write(
              bytes,
              written,
              bytes.length - written,
              packet.offset + written,
            )
            if (result.bytesWritten === 0) throw new Error('short write uploading artifact')
            written += result.bytesWritten
          }
          await fh.sync()
        }
      } finally {
        await fh.close()
      }
      return
    }
    return await this.publishStaged(
      issueId,
      dir,
      meta,
      asArtifactId(randomBytes(6).toString('hex')),
    )
  }

  /**
   * Publish a complete staged upload under `artifactId` (an effect record's,
   * POD-6420): its files move into the artifact dir by rename. Undefined when
   * nothing is staged under `uploadId` (never begun, aborted, swept, or already
   * published). Incomplete members refuse and leave the staging as it is.
   */
  async publishUpload(
    issueId: IssueId,
    uploadId: string,
    artifactId: ArtifactId,
  ): Promise<PublishedUpload | undefined> {
    if (!ID_RE.test(issueId) || !ID_RE.test(uploadId)) throw new Error('bad upload ref')
    const key = `${issueId}/${uploadId}`
    const previous = this.uploadLocks.get(key)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    this.uploadLocks.set(key, held)
    await previous
    const dir = join(this.baseDir, '.uploads', issueId, uploadId)
    try {
      const write = async (): Promise<PublishedUpload | undefined> => {
        const text = await readFile(join(dir, 'meta.json'), 'utf8').catch(() => undefined)
        if (text === undefined) return undefined
        const meta = ArtifactUploadPacket.parse(JSON.parse(text))
        if (meta.action !== 'begin') throw new Error('invalid artifact upload metadata')
        return await this.publishStaged(issueId, dir, meta, artifactId)
      }
      return this.writeFence ? await this.writeFence.runWriter(write) : await write()
    } finally {
      release()
      if (this.uploadLocks.get(key) === held) this.uploadLocks.delete(key)
    }
  }

  private async publishStaged(
    issueId: IssueId,
    dir: string,
    meta: Extract<ArtifactUploadPacket, { action: 'begin' }>,
    artifactId: ArtifactId,
  ): Promise<PublishedUpload> {
    for (const file of meta.files) {
      if ((await stat(join(dir, 'files', file.path))).size !== file.size) {
        throw new Error(`artifact member ${file.path} is incomplete`)
      }
    }
    const target = this.artifactDir(issueId, artifactId)
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    await rename(join(dir, 'files'), target)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return {
      path: meta.path,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      snapshot: { artifactId, entry: meta.entry, files: meta.files, sourcePaths: [] },
    }
  }

  /** The existing pending-upload timer also expires interrupted CLI transfers. */
  async sweepUploads(now = Date.now()): Promise<void> {
    const sweep = async () => {
      const base = join(this.baseDir, '.uploads')
      for (const issue of await readdir(base).catch(() => [] as string[])) {
        for (const upload of await readdir(join(base, issue)).catch(() => [] as string[])) {
          const dir = join(base, issue, upload)
          const modified = (await stat(dir).catch(() => undefined))?.mtimeMs
          if (
            modified !== undefined &&
            now - modified > 24 * 60 * 60 * 1000 &&
            !this.uploadLocks.has(`${issue}/${upload}`)
          ) {
            await rm(dir, { recursive: true, force: true })
          }
        }
      }
    }
    if (this.writeFence) await this.writeFence.runWriter(sweep)
    else await sweep()
  }

  /**
   * Snapshot the source path(s) into a fresh artifactId dir. A directory source
   * becomes a bundle (recursive walk via the daemon's sandboxed dir listing);
   * plain files land at their basename. Any pull/write failure removes the
   * partial dir and rethrows — nothing half-registered.
   */
  async snapshot(o: ArtifactSnapshotInput): Promise<ArtifactSnapshot> {
    const write = async () => await this.snapshotWritable(o)
    return this.writeFence ? await this.writeFence.runWriter(write) : await write()
  }

  /** Store browser-provided bytes as an issue artifact without first writing a
   *  source file into a checkout or daemon upload directory. */
  async upload(o: ArtifactUploadInput): Promise<ArtifactSnapshot> {
    const write = async () => await this.uploadWritable(o)
    return this.writeFence ? await this.writeFence.runWriter(write) : await write()
  }

  /**
   * Take a pending chat upload's file dir as this artifact's dir, by rename
   * (POD-2148): no bytes are re-read. Idempotent per `artifactId` — a retried
   * claim whose move already happened finds the artifact in place.
   */
  async adopt(o: {
    issueId: IssueId
    artifactId: ArtifactId
    fromDir: string
    entry: string
  }): Promise<ArtifactSnapshot> {
    const write = async (): Promise<ArtifactSnapshot> => {
      const dir = this.artifactDir(o.issueId, o.artifactId)
      const target = join(dir, o.entry)
      this.assertInBase(target)
      const placed = await stat(target).catch(() => undefined)
      if (!placed) {
        await mkdir(dirname(dir), { recursive: true })
        await rename(o.fromDir, dir)
      }
      const size = placed?.size ?? (await stat(target)).size
      return {
        artifactId: o.artifactId,
        entry: o.entry,
        files: [{ path: o.entry, size }],
        sourcePaths: [],
      }
    }
    return this.writeFence ? await this.writeFence.runWriter(write) : await write()
  }

  /** Move an artifact dir out to `toDir` (the reverse of {@link adopt}): a
   *  chat upload whose task failed to launch returns to pending (POD-2148).
   *  Nothing to move, or a target already in place, is left as it is. */
  async relinquish(o: { issueId: IssueId; artifactId: ArtifactId; toDir: string }): Promise<void> {
    const write = async (): Promise<void> => {
      const dir = this.artifactDir(o.issueId, o.artifactId)
      if (!(await stat(dir).catch(() => undefined))) return
      if (await stat(o.toDir).catch(() => undefined)) return
      await mkdir(dirname(o.toDir), { recursive: true })
      await rename(dir, o.toDir)
    }
    await (this.writeFence ? this.writeFence.runWriter(write) : write())
  }

  private async uploadWritable(o: ArtifactUploadInput): Promise<ArtifactSnapshot> {
    if (
      !o.filename ||
      o.filename === '.' ||
      o.filename === '..' ||
      o.filename.includes('/') ||
      o.filename.includes('\\') ||
      o.filename.includes('\0')
    ) {
      throw new Error('artifact filename must be a plain filename')
    }
    const bytes = Buffer.from(o.dataBase64, 'base64')
    if (bytes.length > ARTIFACT_FILE_CAP_BYTES) {
      throw new Error(
        `${o.filename} is ${bytes.length} bytes (per-file cap ${ARTIFACT_FILE_CAP_BYTES / (1024 * 1024)}MB)`,
      )
    }
    const artifactId = asArtifactId(randomBytes(6).toString('hex'))
    const dir = this.artifactDir(o.issueId, artifactId)
    const target = join(dir, o.filename)
    this.assertInBase(target)
    try {
      await mkdir(dir, { recursive: true })
      const fh = await open(target, 'w')
      try {
        await fh.writeFile(bytes)
        await fh.sync()
      } finally {
        await fh.close()
      }
      return {
        artifactId,
        entry: o.filename,
        files: [{ path: o.filename, size: bytes.length }],
        sourcePaths: [],
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async snapshotWritable(o: ArtifactSnapshotInput): Promise<ArtifactSnapshot> {
    // MINT SITE for an ArtifactId — generated here, so the brand is applied here.
    const artifactId = o.artifactId ?? asArtifactId(randomBytes(6).toString('hex'))
    const dir = this.artifactDir(o.issueId, artifactId)
    // A keyed id may hold what an earlier, crashed run of the same record left.
    if (o.artifactId) await rm(dir, { recursive: true, force: true })
    const machine = o.machineId ? { machineId: o.machineId } : {}
    const abs = (p: string) => resolveMachinePath(o.root, p)
    try {
      // Resolve the pull plan: [absolute source path, relpath inside the bundle].
      let plan: Array<{ src: string; rel: string; sourcePath: string }>
      const listed = await this.rpc.listDir({ ...machine, root: o.root, path: abs(o.sourcePath) })
      if (listed.ok) {
        plan = (await this.walkDir(o.root, o.machineId, listed.path)).map((file) => ({
          ...file,
          sourcePath: normalizeMachinePath(
            o.sourcePath + machinePathSeparator(o.root) + file.rel,
            o.root,
          ),
        }))
        if (plan.length === 0) throw new Error(`directory ${o.sourcePath} has no files`)
      } else {
        const paths = [o.sourcePath, ...(o.extraPaths ?? [])]
        plan = paths.map((p) => ({
          src: abs(p),
          rel: machinePathBasename(p, o.root),
          sourcePath: p,
        }))
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
      return {
        artifactId,
        entry: pickEntry(files.map((f) => f.path)),
        files,
        sourcePaths: plan.map((file) => file.sourcePath),
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /** Recursive sandboxed walk rooted at `dirAbs`; relpaths are relative to it. */
  private async walkDir(
    root: string,
    machineId: MachineId | undefined,
    dirAbs: string,
  ): Promise<Array<{ src: string; rel: string }>> {
    const machine = machineId ? { machineId } : {}
    const out: Array<{ src: string; rel: string }> = []
    const pending: string[] = ['']
    while (pending.length) {
      const relDir = pending.shift() as string
      const absDir = relDir ? joinMachinePath(dirAbs, relDir) : dirAbs
      const r = await this.rpc.listDir({ ...machine, root, path: absDir })
      if (!r.ok) throw new Error(r.error ?? `cannot list ${absDir}`)
      for (const e of r.entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        if (e.isDir) pending.push(rel)
        else out.push({ src: joinMachinePath(dirAbs, rel), rel })
        if (out.length > ARTIFACT_FILE_COUNT_CAP) {
          throw new Error(`artifact bundle exceeds ${ARTIFACT_FILE_COUNT_CAP} files`)
        }
      }
    }
    return out
  }

  /** Chunked daemon pull of one file → durable local write. Returns byte size. */
  private async pullFile(
    target: { machineId?: MachineId; root: string },
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
    issueId: IssueId,
    artifactId: ArtifactId,
    relPath: string,
    range?: { offset: number; length: number },
  ): Promise<{ bytes: Buffer; contentType: string; size: number } | null> {
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
      if (!range) {
        return {
          bytes: await readFile(target),
          contentType: artifactContentType(target),
          size: st.size,
        }
      }
      const length = Math.min(range.length, Math.max(0, st.size - range.offset))
      const buffer = Buffer.alloc(length)
      const fh = await open(target, 'r')
      let bytesRead = 0
      try {
        ;({ bytesRead } = await fh.read(buffer, 0, length, range.offset))
      } finally {
        await fh.close()
      }
      return {
        bytes: buffer.subarray(0, bytesRead),
        contentType: artifactContentType(target),
        size: st.size,
      }
    } catch {
      return null
    }
  }

  /** Delete one snapshot dir (artifact-remove / post-replace cleanup). */
  async remove(issueId: IssueId, artifactId: ArtifactId): Promise<void> {
    const write = async () =>
      await rm(this.artifactDir(issueId, artifactId), { recursive: true, force: true })
    await (this.writeFence ? await this.writeFence.runWriter(write) : await write())
  }

  /** Delete every snapshot of an issue (hard issue deletion). */
  async removeIssue(issueId: IssueId): Promise<void> {
    if (!ID_RE.test(issueId)) return
    const write = async () => {
      await rm(join(this.baseDir, issueId), { recursive: true, force: true })
      await rm(join(this.baseDir, '.uploads', issueId), { recursive: true, force: true })
    }
    await (this.writeFence ? await this.writeFence.runWriter(write) : await write())
  }

  private assertInBase(p: string): void {
    const resolved = resolve(p)
    if (!resolved.startsWith(resolve(this.baseDir) + sep)) throw new Error('path escapes store')
  }
}
