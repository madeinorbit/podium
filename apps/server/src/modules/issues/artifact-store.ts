import { randomBytes } from 'node:crypto'
import {
  BlobConditionFailed,
  type BlobKey,
  BlobNotFound,
  type BlobStore,
  joinKey,
  keySegment,
  padNumber,
  parsePadded,
} from '@podium/blob-store'
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
import type { ArtifactUploadsRepository } from '../../store/artifact-uploads'

/**
 * Permanent artifact snapshot store (#441), on the workspace's
 * blob store (POD-6963 design 2.4).
 *
 * At `artifact-add` time the server pulls the file bytes from the owning daemon
 * (existing readAsset RPC, chunked for large files) and stores each member at
 * `artifacts/<issueId>/<artifactId>/<relpath...>`, so artifacts survive tmp
 * cleanup / worktree deletion / the machine going offline. On local disk that
 * key is the path under the state directory it always was. The stored copy is
 * immutable — re-adding the same source path mints a NEW artifactId
 * (new-id-then-swap keeps served URLs consistent with content).
 *
 * CLI BUNDLE UPLOADS arrive as bounded packets. Each packet is one chunk object
 * at `artifacts/.uploads/<issue>/<upload>/<member>/<offset>` (the member's index
 * in the begin packet, the offset padded to 12 digits), written only if absent;
 * a retried packet finds its key and compares bytes. The upload's state is a row
 * of `artifact_uploads`, and a packet is accepted by a conditional update of its
 * received bytes, so two processes receiving one upload are ordered by the
 * database. Publishing composes each member's chunks, in key order, into its
 * final key, then deletes the staging and the row. A chunk that is missing at
 * publish fails it with "upload incomplete" and keeps the staging for the
 * day-old sweep: nothing is published half.
 *
 * Writes are fenced by the local adapter itself during a server transfer
 * (design 2.8); this store does not call the fence.
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

/** The upload state this store needs (`ArtifactUploadsRepository`, structurally). */
export type ArtifactUploadState = Pick<
  ArtifactUploadsRepository,
  'begin' | 'get' | 'advance' | 'delete' | 'deleteIssue' | 'createdBefore'
>

export interface IssueArtifactStoreOptions {
  /** This workspace's user files. */
  files: BlobStore
  /** This workspace's `artifact_uploads` rows. */
  uploads: ArtifactUploadState
  rpc: ArtifactRpc
  now?: () => number
}

/** A stored member, streamed. */
export interface ArtifactStream {
  body: ReadableStream<Uint8Array>
  contentType: string
  /** The whole member's size; with a range, `body` holds only the clipped range. */
  size: number
  etag: string
}

/** Thrown when a publish finds its chunks do not cover a member. */
export class UploadIncomplete extends Error {
  override readonly name = 'UploadIncomplete'
  constructor(detail: string) {
    super(`upload incomplete: ${detail}`)
  }
}

// Dot-prefixed directories are private staging, never public artifact refs.
const ID_RE = /^(?!\.)[A-Za-z0-9._-]+$/

const ARTIFACTS = 'artifacts'
const UPLOADS = '.uploads'
/** Chunk offsets: 12 digits holds the 100 MB per-file cap with room to spare. */
const OFFSET_WIDTH = 12
/** Member indexes: 4 digits holds the 200-file cap. */
const MEMBER_WIDTH = 4
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000
const SWEEP_BATCH = 200
/** Tries of one packet against concurrent acceptances of the same upload. */
const ACCEPT_ATTEMPTS = 8

/** The added HTML/MD file (or the first file) is the bundle's primary entry. */
function pickEntry(relPaths: string[]): string {
  const primary = relPaths.find((p) => /\.(html?|md)$/i.test(p))
  return primary ?? relPaths[0] ?? ''
}

function assertIds(...ids: string[]): void {
  for (const id of ids) if (!ID_RE.test(id)) throw new Error('bad artifact ref')
}

function artifactPrefix(issueId: IssueId, artifactId: ArtifactId): BlobKey {
  assertIds(issueId, artifactId)
  return joinKey(ARTIFACTS, issueId, artifactId)
}

/**
 * A member's key: each path segment as a key segment, so a plain name keeps its
 * path on disk and any other name is encoded (design 2.1).
 */
function memberKey(issueId: IssueId, artifactId: ArtifactId, relPath: string): BlobKey {
  return joinKey(artifactPrefix(issueId, artifactId), ...relPath.split('/').map(keySegment))
}

/** {@link memberKey} for a write: a name that cannot be stored is refused by name. */
function storableMemberKey(issueId: IssueId, artifactId: ArtifactId, relPath: string): BlobKey {
  const prefix = artifactPrefix(issueId, artifactId)
  try {
    return joinKey(prefix, ...relPath.split('/').map(keySegment))
  } catch {
    throw new Error(`artifact member ${relPath} has a name too long to store`)
  }
}

function uploadsPrefix(issueId: IssueId): BlobKey {
  assertIds(issueId)
  return joinKey(ARTIFACTS, UPLOADS, issueId)
}

function uploadPrefix(issueId: IssueId, uploadId: string): BlobKey {
  assertIds(uploadId)
  return joinKey(uploadsPrefix(issueId), uploadId)
}

function memberStaging(issueId: IssueId, uploadId: string, member: number): BlobKey {
  return joinKey(uploadPrefix(issueId, uploadId), padNumber(member, MEMBER_WIDTH))
}

function chunkKey(issueId: IssueId, uploadId: string, member: number, offset: number): BlobKey {
  return joinKey(memberStaging(issueId, uploadId, member), padNumber(offset, OFFSET_WIDTH))
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer())
}

type BeginPacket = Extract<ArtifactUploadPacket, { action: 'begin' }>

function assertMemberPaths(packet: BeginPacket): void {
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
    for (const part of file.path.split('/')) {
      try {
        keySegment(part)
      } catch {
        throw new Error(`artifact member ${file.path} has a name too long to store`)
      }
    }
  }
  if (!paths.has(packet.entry)) throw new Error('artifact entry must name a bundle member')
  if (packet.files.reduce((sum, file) => sum + file.size, 0) > ARTIFACT_BUNDLE_CAP_BYTES) {
    throw new Error('artifact bundle exceeds 500MB')
  }
}

function parseBegin(json: string): BeginPacket {
  const meta = ArtifactUploadPacket.parse(JSON.parse(json))
  if (meta.action !== 'begin') throw new Error('invalid artifact upload metadata')
  return meta
}

export class IssueArtifactStore {
  private readonly files: BlobStore
  private readonly uploads: ArtifactUploadState
  private readonly rpc: ArtifactRpc
  private readonly now: () => number

  constructor(options: IssueArtifactStoreOptions) {
    this.files = options.files
    this.uploads = options.uploads
    this.rpc = options.rpc
    this.now = options.now ?? Date.now
  }

  /** Bounded packets let CLI files cross the agent relay without lifting its
   * request cap. Incomplete uploads never appear in the issue panel. */
  async transfer(
    issueId: IssueId,
    raw: ArtifactUploadPacket,
  ): Promise<{ snapshot: ArtifactSnapshot; path: string; title?: string } | undefined> {
    const packet = ArtifactUploadPacket.parse(raw)
    if (!ID_RE.test(issueId)) throw new Error('bad issue ref')
    switch (packet.action) {
      case 'abort':
        await this.discardUpload(issueId, packet.uploadId)
        return
      case 'begin':
        await this.beginUpload(issueId, packet)
        return
      case 'chunk':
        await this.acceptChunk(issueId, packet)
        return
      case 'commit': {
        const row = await this.uploads.get(issueId, packet.uploadId)
        if (!row) throw new Error('no artifact upload is staged under this id')
        return await this.publishStaged(
          issueId,
          packet.uploadId,
          parseBegin(row.beginJson),
          row.received,
          asArtifactId(randomBytes(6).toString('hex')),
        )
      }
    }
  }

  private async beginUpload(issueId: IssueId, packet: BeginPacket): Promise<void> {
    assertMemberPaths(packet)
    uploadPrefix(issueId, packet.uploadId)
    // A retry or competing sender never resets an upload whose chunks have arrived.
    const created = await this.uploads.begin({
      issueId,
      uploadId: packet.uploadId,
      beginJson: JSON.stringify(packet),
      received: packet.files.map(() => 0),
      createdAt: this.now(),
    })
    if (!created) throw new Error('this artifact upload has already begun')
  }

  /**
   * Accept one packet: write its chunk object if absent, then advance the
   * member's received bytes where the row still holds what was read. A packet
   * below the received count is a replay and must match the chunk stored at its
   * offset.
   */
  private async acceptChunk(
    issueId: IssueId,
    packet: Extract<ArtifactUploadPacket, { action: 'chunk' }>,
  ): Promise<void> {
    const bytes = Buffer.from(packet.dataBase64, 'base64')
    if (
      bytes.toString('base64') !== packet.dataBase64 ||
      bytes.length > ARTIFACT_UPLOAD_CHUNK_BYTES
    ) {
      throw new Error('invalid artifact chunk')
    }
    for (let attempt = 0; attempt < ACCEPT_ATTEMPTS; attempt += 1) {
      const row = await this.uploads.get(issueId, packet.uploadId)
      if (!row) throw new Error('no artifact upload is staged under this id')
      const meta = parseBegin(row.beginJson)
      const member = meta.files.findIndex((file) => file.path === packet.file)
      const file = meta.files[member]
      if (!file) throw new Error('unknown artifact member')
      const received = row.received[member] ?? 0
      if (packet.offset + bytes.length > file.size || packet.offset > received) {
        throw new Error('artifact chunk exceeds the declared size or skips bytes')
      }
      const key = chunkKey(issueId, packet.uploadId, member, packet.offset)
      if (packet.offset < received) {
        await this.assertSameChunk(key, bytes)
        return
      }
      if (bytes.length === 0) return
      await this.putChunk(key, bytes)
      const next = [...row.received]
      next[member] = packet.offset + bytes.length
      if (await this.uploads.advance(issueId, packet.uploadId, row.received, next)) return
      // Another packet of this upload was accepted since the read: read again.
    }
    throw new Error('artifact upload is busy; send the packet again')
  }

  private async putChunk(key: BlobKey, bytes: Buffer): Promise<void> {
    if (!this.files.conditionalWrites) {
      if (await this.files.head(key)) await this.assertSameChunk(key, bytes)
      else await this.files.put(key, bytes)
      return
    }
    try {
      await this.files.put(key, bytes, { ifAbsent: true })
    } catch (error) {
      if (!(error instanceof BlobConditionFailed)) throw error
      // Written by a replay of this packet, or a crash before its row advanced.
      await this.assertSameChunk(key, bytes)
    }
  }

  private async assertSameChunk(key: BlobKey, bytes: Buffer): Promise<void> {
    const stored = await this.files.get(key)
    if (!stored || !(await bytesOf(stored.body)).equals(bytes)) {
      throw new Error('artifact chunk conflicts with previously uploaded bytes')
    }
  }

  /**
   * Publish a complete staged upload under `artifactId` (an effect record's,
   * POD-6420): each member's chunks are composed into its artifact key.
   * Undefined when nothing is staged under `uploadId` (never begun, aborted,
   * swept, or already published). A member its chunks do not cover refuses with
   * "upload incomplete" and leaves the staging as it is.
   */
  async publishUpload(
    issueId: IssueId,
    uploadId: string,
    artifactId: ArtifactId,
  ): Promise<PublishedUpload | undefined> {
    if (!ID_RE.test(issueId) || !ID_RE.test(uploadId)) throw new Error('bad upload ref')
    const row = await this.uploads.get(issueId, uploadId)
    if (!row) return undefined
    return await this.publishStaged(
      issueId,
      uploadId,
      parseBegin(row.beginJson),
      row.received,
      artifactId,
    )
  }

  private async publishStaged(
    issueId: IssueId,
    uploadId: string,
    meta: BeginPacket,
    received: readonly number[],
    artifactId: ArtifactId,
  ): Promise<PublishedUpload> {
    meta.files.forEach((file, member) => {
      const have = received[member] ?? 0
      if (have !== file.size) {
        throw new UploadIncomplete(`${file.path} has ${have} of ${file.size} bytes`)
      }
    })
    const prefix = artifactPrefix(issueId, artifactId)
    // The id is the record's: clear what a crashed run of the same record left.
    await this.deletePrefix(prefix)
    try {
      for (const [member, file] of meta.files.entries()) {
        await this.composeMember(issueId, uploadId, member, file, artifactId)
      }
    } catch (error) {
      await this.deletePrefix(prefix).catch(() => {})
      throw error
    }
    await this.deletePrefix(uploadPrefix(issueId, uploadId))
    await this.uploads.delete(issueId, uploadId)
    return {
      path: meta.path,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      snapshot: { artifactId, entry: meta.entry, files: meta.files, sourcePaths: [] },
    }
  }

  /** Stream one member's chunks, in key order, into its artifact key. */
  private async composeMember(
    issueId: IssueId,
    uploadId: string,
    member: number,
    file: { path: string; size: number },
    artifactId: ArtifactId,
  ): Promise<void> {
    const staging = memberStaging(issueId, uploadId, member)
    const chunks: BlobKey[] = []
    let covered = 0
    for await (const entry of this.files.list(staging)) {
      const offset = parsePadded(entry.key.slice(staging.length + 1), OFFSET_WIDTH)
      if (offset !== covered) break
      chunks.push(entry.key)
      covered += entry.size
    }
    if (covered !== file.size) {
      throw new UploadIncomplete(`${file.path}: its chunks hold ${covered} of ${file.size} bytes`)
    }
    const files = this.files
    let next = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const key = chunks[next]
        if (key === undefined) {
          controller.close()
          return
        }
        next += 1
        const chunk = await files.get(key)
        if (!chunk) {
          controller.error(new UploadIncomplete(`${file.path}: chunk ${key} is missing`))
          return
        }
        controller.enqueue(await bytesOf(chunk.body))
      },
    })
    const written = await this.files.put(storableMemberKey(issueId, artifactId, file.path), body, {
      contentType: artifactContentType(file.path),
    })
    if (written.size !== file.size) {
      throw new UploadIncomplete(`${file.path} composed to ${written.size} of ${file.size} bytes`)
    }
  }

  /** The hourly pending-upload timer also expires interrupted CLI transfers. */
  async sweepUploads(now = this.now()): Promise<void> {
    while (true) {
      const stale = await this.uploads.createdBefore(now - SWEEP_AGE_MS, SWEEP_BATCH)
      for (const { issueId, uploadId } of stale) await this.discardUpload(issueId, uploadId)
      if (stale.length < SWEEP_BATCH) return
    }
  }

  /** Delete an upload's staging, then its row. */
  private async discardUpload(issueId: IssueId, uploadId: string): Promise<void> {
    await this.deletePrefix(uploadPrefix(issueId, uploadId))
    await this.uploads.delete(issueId, uploadId)
  }

  /**
   * Snapshot the source path(s) into a fresh artifactId. A directory source
   * becomes a bundle (recursive walk via the daemon's sandboxed dir listing);
   * plain files land at their basename. Any pull/write failure removes what
   * was written and rethrows — nothing half-registered.
   */
  async snapshot(o: ArtifactSnapshotInput): Promise<ArtifactSnapshot> {
    // MINT SITE for an ArtifactId — generated here, so the brand is applied here.
    const artifactId = o.artifactId ?? asArtifactId(randomBytes(6).toString('hex'))
    const prefix = artifactPrefix(o.issueId, artifactId)
    // A keyed id may hold what an earlier, crashed run of the same record left.
    if (o.artifactId) await this.deletePrefix(prefix)
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
        const size = await this.pullFile(
          { ...machine, root: o.root },
          src,
          storableMemberKey(o.issueId, artifactId, rel),
          rel,
        )
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
      await this.deletePrefix(prefix).catch(() => {})
      throw err
    }
  }

  /** Store browser-provided bytes as an issue artifact without first writing a
   *  source file into a checkout or daemon upload directory. */
  async upload(o: ArtifactUploadInput): Promise<ArtifactSnapshot> {
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
    await this.files.put(storableMemberKey(o.issueId, artifactId, o.filename), bytes, {
      contentType: artifactContentType(o.filename),
    })
    return {
      artifactId,
      entry: o.filename,
      files: [{ path: o.filename, size: bytes.length }],
      sourcePaths: [],
    }
  }

  /**
   * Take a pending chat upload's file as this artifact's member (POD-2148): its
   * bytes are copied from `from`, the upload's key, to the artifact key, then
   * the source is deleted (design 2.5, copy then delete). Idempotent per
   * `artifactId`: a retried claim whose copy already happened finds the
   * artifact in place and only deletes what is left of the source.
   */
  async adopt(o: {
    issueId: IssueId
    artifactId: ArtifactId
    from: BlobKey
    entry: string
  }): Promise<ArtifactSnapshot> {
    const key = storableMemberKey(o.issueId, o.artifactId, o.entry)
    let size = (await this.files.head(key))?.size
    if (size === undefined) {
      try {
        await this.files.copy(o.from, key)
      } catch (error) {
        // A concurrent claim of the same upload copied it and removed the source.
        if (!(error instanceof BlobNotFound) || (await this.files.head(key)) === undefined) {
          throw error
        }
      }
      size = (await this.files.head(key))?.size ?? 0
    }
    await this.files.delete(o.from)
    return {
      artifactId: o.artifactId,
      entry: o.entry,
      files: [{ path: o.entry, size }],
      sourcePaths: [],
    }
  }

  /** Copy a chat upload's artifact back to `to`, its pending key, and delete the
   *  artifact (the reverse of {@link adopt}): a chat upload whose task failed to
   *  launch returns to pending (POD-2148). Nothing to move is left as it is; a
   *  source already back in place (a crash after the copy) is kept, and only the
   *  artifact goes. */
  async relinquish(o: { issueId: IssueId; artifactId: ArtifactId; to: BlobKey }): Promise<void> {
    const prefix = artifactPrefix(o.issueId, o.artifactId)
    const keys = await this.keysUnder(prefix)
    if (keys.length === 0) return
    const [member] = keys
    if (keys.length !== 1 || member === undefined) {
      throw new Error(`artifact ${o.artifactId} holds ${keys.length} files, not one chat upload`)
    }
    if ((await this.files.head(o.to)) === undefined) await this.files.copy(member, o.to)
    await this.deletePrefix(prefix)
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

  /**
   * Chunked daemon pull of one file, streamed into its member key. Returns the
   * byte size. A failed or short pull errors the stream, so the put stores
   * nothing.
   */
  private async pullFile(
    target: { machineId?: MachineId; root: string },
    srcAbs: string,
    key: BlobKey,
    rel: string,
  ): Promise<number> {
    const rpc = this.rpc
    let offset = 0
    let total: number | undefined
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (total !== undefined && offset >= total) {
          controller.close()
          return
        }
        const r = await rpc.readAsset({ ...target, path: srcAbs, offset, length: PULL_CHUNK_BYTES })
        if (!r.ok || r.dataBase64 == null) {
          controller.error(new Error(`cannot read ${srcAbs}: ${r.error ?? 'read failed'}`))
          return
        }
        const buf = Buffer.from(r.dataBase64, 'base64')
        total = r.size ?? buf.length
        if (total > ARTIFACT_FILE_CAP_BYTES) {
          controller.error(
            new Error(
              `${srcAbs} is ${total} bytes (per-file cap ${ARTIFACT_FILE_CAP_BYTES / (1024 * 1024)}MB)`,
            ),
          )
          return
        }
        if (buf.length === 0 && offset < total) {
          controller.error(new Error(`short read pulling ${srcAbs}`))
          return
        }
        offset += buf.length
        if (buf.length > 0) controller.enqueue(buf)
        if (offset >= total) controller.close()
      },
    })
    const written = await this.files.put(key, body, { contentType: artifactContentType(rel) })
    return written.size
  }

  /**
   * Stream one stored member, with an optional byte range clipped to it. Null
   * when the ref, the path or the member does not exist.
   */
  async readStream(
    issueId: IssueId,
    artifactId: ArtifactId,
    relPath: string,
    range?: { offset: number; length: number },
  ): Promise<ArtifactStream | null> {
    let key: BlobKey
    try {
      key = memberKey(issueId, artifactId, relPath)
    } catch {
      return null
    }
    const stored = await this.files.get(key, range)
    if (!stored) return null
    return {
      body: stored.body,
      contentType: artifactContentType(relPath),
      size: stored.size,
      etag: stored.etag,
    }
  }

  /** Delete one snapshot (artifact-remove / post-replace cleanup): a prefix delete. */
  async remove(issueId: IssueId, artifactId: ArtifactId): Promise<void> {
    await this.deletePrefix(artifactPrefix(issueId, artifactId))
  }

  /** Delete every snapshot and staged upload of an issue (hard issue deletion). */
  async removeIssue(issueId: IssueId): Promise<void> {
    if (!ID_RE.test(issueId)) return
    await this.deletePrefix(joinKey(ARTIFACTS, issueId))
    await this.deletePrefix(uploadsPrefix(issueId))
    await this.uploads.deleteIssue(issueId)
  }

  private async keysUnder(prefix: BlobKey): Promise<BlobKey[]> {
    const keys: BlobKey[] = []
    for await (const entry of this.files.list(prefix)) keys.push(entry.key)
    return keys
  }

  /** List, then delete: a listing is never walked while it is being deleted. */
  private async deletePrefix(prefix: BlobKey): Promise<void> {
    for (const key of await this.keysUnder(prefix)) await this.files.delete(key)
  }
}
