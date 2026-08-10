import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import {
  SERVER_TRANSFER_CAPACITY_MARGIN,
  SERVER_TRANSFER_MAX_CHUNK_BYTES,
  type ControlMessage,
  canonicalServerTransferManifest,
  type ServerTransferErrorCode,
  type ServerTransferManifest,
  type ServerTransferManifestEntry,
  type ServerTransferOperation,
  type ServerTransferProof,
  type ServerTransferResultMessage,
  ServerTransferServingProof,
  wireSchemaDigest,
} from '@podium/protocol'
import { configPath, stateDir } from '@podium/runtime/config'
import { applySetup, validatePublicUrl } from '@podium/runtime/setup'
import { openDatabase } from '@podium/runtime/sqlite'
import type { ControlHandlers, DaemonContext } from './control/context'

const TRANSFER_DIR = '.server-transfer'
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const PORTABLE_ROOTS = ['transcripts', 'artifacts', 'uploads'] as const

type StageState = 'staging' | 'validated' | 'promoting' | 'promoted' | 'aborted' | 'uncertain'
interface PromotionInventoryEntry {
  path: string
  kind: 'portable' | 'config'
  hadOriginal: boolean
  size?: number
  sha256?: string
  mode?: number
}
interface StageMeta {
  version: 1
  transferId: string
  manifest: ServerTransferManifest
  manifestDigest: string
  totalBytes: number
  received: Record<string, number>
  state: StageState
  targetMachineId: string
  sourceMachineId: string
  proof?: ServerTransferProof
  servingProof?: ServerTransferServingProof
  promotionPlan?: PromotionInventoryEntry[]
  promotion?: {
    idempotencyKey: string
    publicUrl: string
    targetMode: 'server'
  }
  publicUrl?: string
  acknowledged?: boolean
}

let heldLock: { transferId: string; handle: Awaited<ReturnType<typeof open>> } | undefined

class ServerTransferError extends Error {
  constructor(
    readonly code: ServerTransferErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function fail(code: ServerTransferErrorCode, message: string): never {
  throw new ServerTransferError(code, message)
}

type ServerTransferRequest = Extract<ControlMessage, { type: `serverTransfer${string}Request` }>

function operationFor(type: ServerTransferRequest['type']): ServerTransferOperation {
  switch (type) {
    case 'serverTransferPrepareRequest':
      return 'prepare'
    case 'serverTransferChunkRequest':
      return 'chunk'
    case 'serverTransferValidateRequest':
      return 'validate'
    case 'serverTransferPromoteRequest':
      return 'promote'
    case 'serverTransferAbortRequest':
      return 'abort'
    case 'serverTransferStatusRequest':
      return 'status'
    case 'serverTransferAcknowledgeRequest':
      return 'acknowledge'
  }
}

function root(): string {
  return join(stateDir(), TRANSFER_DIR)
}

function stageRoot(transferId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(transferId)) fail('invalid-request', 'invalid transfer id')
  return join(root(), transferId)
}

function metaPath(transferId: string): string {
  return join(stageRoot(transferId), 'state.json')
}

function lockPath(): string {
  return join(root(), 'active.lock')
}

function assertPortablePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    fail('unsafe-path', `unsafe transfer path: ${path}`)
  }
  const allowed =
    path === 'podium.db' ||
    path === 'enrollment.ledger' ||
    PORTABLE_ROOTS.some((prefix) => path.startsWith(`${prefix}/`))
  if (!allowed || normalize(path) !== path) fail('unsafe-path', `path is not portable: ${path}`)
}

function stagePath(transferId: string, path: string): string {
  assertPortablePath(path)
  const base = resolve(stageRoot(transferId), 'files')
  const candidate = resolve(base, path)
  if (candidate !== base && !candidate.startsWith(`${base}/`))
    fail('unsafe-path', `transfer path escaped stage: ${path}`)
  return candidate
}

function statePath(path: string): string {
  assertPortablePath(path)
  const base = resolve(stateDir())
  const candidate = resolve(base, path)
  if (candidate !== base && !candidate.startsWith(`${base}/`))
    fail('unsafe-path', `transfer path escaped state root: ${path}`)
  return candidate
}

function stagePartPath(transferId: string, path: string): string {
  assertPortablePath(path)
  return join(stageRoot(transferId), 'parts', path)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory())
      fail('unsafe-path', 'transfer directory is not a real directory')
    return
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const created = await lstat(path)
  if (created.isSymbolicLink() || !created.isDirectory())
    fail('unsafe-path', 'transfer directory is not a real directory')
}

/** Refuse every existing parent below `base` unless it is a real directory. */
async function assertRealParents(base: string, relativePath: string): Promise<void> {
  let current = base
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = join(current, segment)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) return
    if (info.isSymbolicLink() || !info.isDirectory())
      fail('unsafe-path', `transfer parent is not a real directory: ${relativePath}`)
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  await syncDirectory(dirname(path))
}

async function readMeta(transferId: string): Promise<StageMeta> {
  const parsed = JSON.parse(await readFile(metaPath(transferId), 'utf8')) as StageMeta
  if (parsed.version !== 1 || parsed.transferId !== transferId)
    fail('invalid-request', 'invalid transfer journal')
  return parsed
}

async function readRequestMeta(transferId: string): Promise<StageMeta> {
  try {
    return await readMeta(transferId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      fail('unknown-transfer', 'transfer stage does not exist')
    throw error
  }
}

async function acquireLock(transferId: string): Promise<void> {
  if (heldLock?.transferId === transferId) return
  if (heldLock) fail('refused', `another transfer is active: ${heldLock.transferId}`)
  await ensureRealDirectory(root())
  for (;;) {
    try {
      const handle = await open(lockPath(), 'wx', 0o600)
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, transferId, startedAt: Date.now() }),
      )
      await handle.sync()
      await syncDirectory(root())
      heldLock = { transferId, handle }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: { pid?: number; transferId?: string } = {}
      try {
        owner = JSON.parse(await readFile(lockPath(), 'utf8')) as typeof owner
      } catch {
        fail('refused', 'another transfer is active (lock unreadable)')
      }
      if (owner.transferId === transferId && owner.pid === process.pid) return
      let alive = false
      if (typeof owner.pid === 'number') {
        try {
          process.kill(owner.pid, 0)
          alive = true
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') alive = true
        }
      }
      if (alive) fail('refused', `another transfer is active: ${owner.transferId ?? 'unknown'}`)
      await rm(lockPath(), { force: true })
      await syncDirectory(root())
    }
  }
}

async function releaseLock(transferId: string): Promise<void> {
  if (heldLock?.transferId !== transferId) return
  await heldLock.handle.close().catch(() => {})
  heldLock = undefined
  await rm(lockPath(), { force: true })
  await syncDirectory(root())
}

function digestManifest(manifest: ServerTransferManifest): string {
  return createHash('sha256').update(canonicalServerTransferManifest(manifest)).digest('hex')
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    hash.update(chunk)
  return hash.digest('hex')
}

async function capacityProof(
  totalBytes: number,
  manifest: ServerTransferManifestEntry[],
): Promise<{ availableBytes: number; requiredBytes: number; sufficient: boolean }> {
  const fs = await statfs(stateDir())
  const availableBytes = fs.bavail * fs.bsize
  let backupBytes = 0
  for (const entry of manifest) {
    const destination = statePath(entry.path)
    await assertRealParents(stateDir(), entry.path)
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!existing) continue
    if (existing.isSymbolicLink() || !existing.isFile())
      fail('unsafe-path', `target path is not a regular file: ${entry.path}`)
    backupBytes += existing.size
  }
  const requiredBytes = Math.ceil(
    (totalBytes + backupBytes) * (1 + SERVER_TRANSFER_CAPACITY_MARGIN),
  )
  return { availableBytes, requiredBytes, sufficient: availableBytes >= requiredBytes }
}

export async function writeFully(
  handle: Awaited<ReturnType<typeof open>>,
  data: Buffer,
  offset: number,
): Promise<void> {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, offset + written)
    if (result.bytesWritten <= 0) fail('internal', 'short transfer write')
    written += result.bytesWritten
  }
}

async function candidateProof(meta: StageMeta): Promise<ServerTransferProof> {
  const dbEntry = meta.manifest.files.find((entry) => entry.path === 'podium.db')
  const ledgerEntry = meta.manifest.files.find((entry) => entry.path === 'enrollment.ledger')
  if (!dbEntry || !ledgerEntry)
    fail('candidate-invalid', 'portable state must include podium.db and enrollment.ledger')

  const ledgerLines = (await readFile(stagePath(meta.transferId, ledgerEntry.path), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return fail('candidate-invalid', 'enrollment ledger contains invalid JSON')
      }
    })
  const header = ledgerLines.find((line) => line.kind === 'header')
  if (
    header?.v !== 1 ||
    typeof header.pairingRoot !== 'string' ||
    !/^[a-f0-9]{64,}$/i.test(header.pairingRoot)
  )
    fail('candidate-invalid', 'enrollment ledger has no valid pairing root')
  if (
    !ledgerLines.some((line) => line.kind === 'enroll' && line.machineId === meta.targetMachineId)
  )
    fail('identity-mismatch', 'target machine is absent from the enrollment ledger')

  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(stagePath(meta.transferId, dbEntry.path), { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    if (integrity?.integrity_check !== 'ok')
      fail('candidate-invalid', 'candidate database failed integrity_check')
    const target = db.prepare('SELECT id FROM machines WHERE id = ?').get(meta.targetMachineId)
    if (!target) fail('identity-mismatch', 'target machine is absent from the candidate database')
    const feed = db.prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1').get() as
      | { feed_id?: string; epoch?: string }
      | undefined
    if (!feed?.feed_id || !feed.epoch)
      fail('candidate-invalid', 'candidate database has no feed identity')
    const schema = db
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY name DESC LIMIT 1')
      .get() as { name?: string } | undefined
    if (!schema?.name) fail('candidate-invalid', 'candidate database has no schema ledger')
    if (feed.feed_id !== meta.manifest.sourceFeedId || feed.epoch !== meta.manifest.sourceFeedEpoch)
      fail('identity-mismatch', 'candidate feed identity does not match transfer manifest')
    if (schema.name !== meta.manifest.schemaVersion)
      fail('candidate-invalid', 'candidate schema does not match transfer manifest')
    return {
      transferId: meta.transferId,
      manifestDigest: meta.manifestDigest,
      targetMachineId: meta.targetMachineId,
      feedId: feed.feed_id,
      feedEpoch: feed.epoch,
      schemaVersion: schema.name,
      buildVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }
  } catch (error) {
    if (error instanceof ServerTransferError) throw error
    throw new ServerTransferError('candidate-invalid', 'candidate database schema is not supported')
  } finally {
    db?.close()
  }
}

function result(
  requestId: string,
  transferId: string,
  operation: ServerTransferOperation,
  value: Omit<ServerTransferResultMessage, 'type' | 'requestId' | 'transferId' | 'operation'>,
): ServerTransferResultMessage {
  return { type: 'serverTransferResult', requestId, transferId, operation, ...value }
}

function validateManifest(
  manifest: ServerTransferManifest,
  manifestDigest: string,
  transferId: string,
  targetMachineId: string,
): void {
  if (manifest.transferId !== transferId) fail('identity-mismatch', 'manifest transfer id changed')
  if (manifest.targetMachineId !== targetMachineId)
    fail('identity-mismatch', 'manifest target identity changed')
  if (manifest.sourceMachineId === manifest.targetMachineId)
    fail('identity-mismatch', 'source and target machines must differ')
  if (manifest.files.length > 20_000) fail('invalid-request', 'transfer manifest is too large')
  if (manifest.packageBytes > MAX_TOTAL_BYTES) fail('capacity-exceeded', 'transfer is too large')
  const sorted = [...manifest.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.files))
    fail('invalid-request', 'manifest must be sorted')
  const seen = new Set<string>()
  let total = 0
  for (const entry of manifest.files) {
    assertPortablePath(entry.path)
    if (seen.has(entry.path)) fail('invalid-request', `duplicate manifest path: `)
    seen.add(entry.path)
    total += entry.size
    if (total > MAX_TOTAL_BYTES) fail('capacity-exceeded', 'transfer is too large')
  }
  if (total !== manifest.packageBytes)
    fail('size-mismatch', 'manifest total does not match packageBytes')
  if (digestManifest(manifest) !== manifestDigest)
    fail('digest-mismatch', 'manifest digest mismatch')
}

async function prepare(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'serverTransferPrepareRequest' }>,
): Promise<ServerTransferResultMessage> {
  validateManifest(msg.manifest, msg.manifestDigest, msg.transferId, ctx.machineId)
  await acquireLock(msg.transferId)
  try {
    const space = await capacityProof(msg.manifest.packageBytes, msg.manifest.files)
    if (!space.sufficient) fail('capacity-exceeded', 'target has insufficient staging capacity')
    const existing = await readMeta(msg.transferId).catch(() => undefined)
    if (existing) {
      if (
        existing.manifestDigest !== msg.manifestDigest ||
        existing.totalBytes !== msg.manifest.packageBytes
      )
        fail('conflicting-digest', 'transfer id is already used for a different manifest')
      if (existing.targetMachineId !== ctx.machineId)
        fail('identity-mismatch', 'transfer target identity changed')
      if (existing.sourceMachineId !== msg.manifest.sourceMachineId)
        fail('identity-mismatch', 'transfer source identity changed')
      return result(msg.requestId, msg.transferId, 'prepare', {
        ok: existing.state !== 'uncertain' && existing.state !== 'promoting',
        state: existing.state,
        manifestDigest: existing.manifestDigest,
        receivedBytes: Object.values(existing.received).reduce((sum, n) => sum + n, 0),
        idempotent: true,
        targetCapability: 'server-only',
        buildVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
        wireSchemaDigest: wireSchemaDigest(),
        space,
        ...(existing.state === 'uncertain' || existing.state === 'promoting'
          ? { errorCode: 'uncertain-commit' as const, error: 'transfer requires recovery' }
          : {}),
      })
    }
    const dir = stageRoot(msg.transferId)
    await ensureRealDirectory(dir)
    for (const entry of msg.manifest.files) {
      await assertRealParents(dir, entry.path)
      const path = stagePartPath(msg.transferId, entry.path)
      await ensureRealDirectory(dirname(path))
      const handle = await open(path, 'wx', entry.mode & 0o777)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(dirname(path))
    }
    const meta: StageMeta = {
      version: 1,
      transferId: msg.transferId,
      manifest: msg.manifest,
      manifestDigest: msg.manifestDigest,
      totalBytes: msg.manifest.packageBytes,
      received: Object.fromEntries(msg.manifest.files.map((entry) => [entry.path, 0])),
      state: 'staging',
      targetMachineId: ctx.machineId,
      sourceMachineId: msg.manifest.sourceMachineId,
    }
    await writeJson(metaPath(msg.transferId), meta)
    return result(msg.requestId, msg.transferId, 'prepare', {
      ok: true,
      state: 'staging',
      manifestDigest: msg.manifestDigest,
      receivedBytes: 0,
      idempotent: false,
      targetCapability: 'server-only',
      buildVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
      wireSchemaDigest: wireSchemaDigest(),
      space,
    })
  } catch (error) {
    await releaseLock(msg.transferId)
    throw error
  }
}

async function chunk(
  msg: Extract<ControlMessage, { type: 'serverTransferChunkRequest' }>,
): Promise<ServerTransferResultMessage> {
  await acquireLock(msg.transferId)
  const meta = await readRequestMeta(msg.transferId)
  if (meta.manifestDigest !== msg.manifestDigest)
    fail('conflicting-digest', 'manifest digest mismatch')
  if (meta.state !== 'staging') {
    if (meta.state === 'promoted') {
      await releaseLock(msg.transferId)
      return result(msg.requestId, msg.transferId, 'chunk', {
        ok: true,
        state: 'promoted',
        manifestDigest: meta.manifestDigest,
        path: msg.path,
        offset: msg.offset,
        idempotent: true,
      })
    }
    fail(
      meta.state === 'uncertain' ? 'uncertain-commit' : 'invalid-request',
      `transfer is not staging: ${meta.state}`,
    )
  }
  const entry = meta.manifest.files.find((candidate) => candidate.path === msg.path)
  if (!entry) fail('unknown-file', `path is not in manifest: ${msg.path}`)
  const data = Buffer.from(msg.data, 'base64')
  if (data.length !== msg.expectedLength || data.toString('base64') !== msg.data)
    fail('invalid-request', 'transfer chunk length or base64 encoding is invalid')
  if (data.length === 0 || data.length > SERVER_TRANSFER_MAX_CHUNK_BYTES)
    fail('oversized-chunk', 'invalid transfer chunk size')
  const received = meta.received[msg.path] ?? 0
  if (msg.offset === received) {
    if (msg.offset + data.length > entry.size)
      fail('size-mismatch', 'transfer chunk exceeds file size')
    const handle = await open(stagePartPath(msg.transferId, msg.path), 'r+')
    try {
      await writeFully(handle, data, msg.offset)
      await handle.truncate(msg.offset + data.length)
      await handle.sync()
    } finally {
      await handle.close()
    }
    meta.received[msg.path] = received + data.length
    await writeJson(metaPath(msg.transferId), meta)
    return result(msg.requestId, msg.transferId, 'chunk', {
      ok: true,
      state: 'staging',
      manifestDigest: meta.manifestDigest,
      path: msg.path,
      offset: msg.offset,
      receivedBytes: data.length,
    })
  }
  if (msg.offset < received && msg.offset + data.length <= received) {
    const handle = await open(stagePartPath(msg.transferId, msg.path), 'r')
    const existing = Buffer.alloc(data.length)
    try {
      const read = await handle.read(existing, 0, data.length, msg.offset)
      if (read.bytesRead !== data.length) fail('size-mismatch', 'staged chunk retry is short')
    } finally {
      await handle.close()
    }
    if (existing.equals(data))
      return result(msg.requestId, msg.transferId, 'chunk', {
        ok: true,
        state: 'staging',
        manifestDigest: meta.manifestDigest,
        path: msg.path,
        offset: msg.offset,
        receivedBytes: data.length,
        idempotent: true,
      })
  }
  fail(
    msg.offset > received ? 'offset-gap' : 'offset-overlap',
    `non-contiguous transfer chunk: expected ${received}, got ${msg.offset}`,
  )
}

async function validate(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'serverTransferValidateRequest' }>,
): Promise<ServerTransferResultMessage> {
  await acquireLock(msg.transferId)
  const meta = await readRequestMeta(msg.transferId)
  if (meta.manifestDigest !== msg.manifestDigest)
    fail('conflicting-digest', 'manifest digest mismatch')
  if (meta.targetMachineId !== ctx.machineId)
    fail('identity-mismatch', 'transfer target identity changed')
  if (meta.state === 'promoted') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'validate', {
      ok: true,
      state: 'promoted',
      manifestDigest: meta.manifestDigest,
      proof: meta.proof,
      servingProof: meta.servingProof,
      idempotent: true,
    })
  }
  if (meta.state === 'uncertain') fail('uncertain-commit', 'transfer requires recovery')
  if (meta.state === 'validated' && meta.proof)
    return result(msg.requestId, msg.transferId, 'validate', {
      ok: true,
      state: 'validated',
      manifestDigest: meta.manifestDigest,
      proof: meta.proof,
      servingProof: meta.servingProof,
      idempotent: true,
    })
  for (const entry of meta.manifest.files) {
    if ((meta.received[entry.path] ?? 0) !== entry.size)
      fail('size-mismatch', `incomplete transfer file: ${entry.path}`)
    const part = stagePartPath(msg.transferId, entry.path)
    const final = stagePath(msg.transferId, entry.path)
    let path = part
    const info = await lstat(part).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      path = final
      return lstat(final)
    })
    if (info.isSymbolicLink()) fail('unsafe-path', `staged file is a symlink: ${entry.path}`)
    if (!info.isFile() || info.size !== entry.size || (info.mode & 0o777) !== entry.mode)
      fail('size-mismatch', `staged file metadata mismatch: ${entry.path}`)
    if ((await fileDigest(path)) !== entry.sha256)
      fail('digest-mismatch', `staged file digest mismatch: ${entry.path}`)
    if (path === part) {
      await ensureRealDirectory(dirname(final))
      await rename(part, final)
      await syncDirectory(dirname(final))
    }
  }
  meta.proof = await candidateProof(meta)
  meta.state = 'validated'
  await writeJson(metaPath(msg.transferId), meta)
  return result(msg.requestId, msg.transferId, 'validate', {
    ok: true,
    state: 'validated',
    manifestDigest: meta.manifestDigest,
    proof: meta.proof,
    idempotent: false,
  })
}

export type ServerTransferCrashPoint =
  | 'before-backup'
  | 'after-backup'
  | 'after-promoting-journal'
  | 'after-install-before-config'
  | 'after-config-before-health'
  | 'after-health-before-proof'

class SimulatedPromotionCrash extends Error {}

async function crashPoint(ctx: DaemonContext, point: ServerTransferCrashPoint): Promise<void> {
  if (!ctx.serverTransferCrashPoint) return
  try {
    await ctx.serverTransferCrashPoint(point)
  } catch (error) {
    throw new SimulatedPromotionCrash(String(error))
  }
}

function livePathFor(item: PromotionInventoryEntry): string {
  return item.kind === 'config' ? configPath() : statePath(item.path)
}

function backupPathFor(meta: StageMeta, item: PromotionInventoryEntry): string {
  const backupRoot = resolve(stageRoot(meta.transferId), 'backup', 'originals')
  const relative = item.kind === 'config' ? 'config.json' : join('portable', item.path)
  const candidate = resolve(backupRoot, relative)
  if (!candidate.startsWith(`${backupRoot}/`))
    fail('unsafe-path', `backup path escaped transfer stage: ${item.path}`)
  return candidate
}

async function inspectOriginal(
  path: string,
  kind: PromotionInventoryEntry['kind'],
): Promise<PromotionInventoryEntry> {
  if (kind === 'portable') await assertRealParents(stateDir(), path)
  const livePath = kind === 'config' ? configPath() : statePath(path)
  const info = await lstat(livePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return { path, kind, hadOriginal: false }
  if (info.isSymbolicLink() || !info.isFile())
    fail('unsafe-path', `target path is not a regular file: ${path}`)
  return {
    path,
    kind,
    hadOriginal: true,
    size: info.size,
    sha256: await fileDigest(livePath),
    mode: info.mode & 0o777,
  }
}

async function buildPromotionInventory(meta: StageMeta): Promise<PromotionInventoryEntry[]> {
  const portable = await Promise.all(
    meta.manifest.files.map((entry) => inspectOriginal(entry.path, 'portable')),
  )
  return [...portable, await inspectOriginal('config.json', 'config')]
}

async function verifyInventoryFile(
  path: string,
  item: PromotionInventoryEntry,
  label: string,
): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!item.hadOriginal) {
    if (info) fail('refused', `${label} appeared after promotion inventory was persisted`)
    return
  }
  if (
    !info ||
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size !== item.size ||
    (info.mode & 0o777) !== item.mode ||
    (await fileDigest(path)) !== item.sha256
  )
    fail('refused', `${label} no longer matches the durable promotion inventory`)
}

async function persistRecoveryBackups(ctx: DaemonContext, meta: StageMeta): Promise<void> {
  if (!meta.promotionPlan) {
    meta.promotionPlan = await buildPromotionInventory(meta)
    await writeJson(metaPath(meta.transferId), meta)
  }

  await crashPoint(ctx, 'before-backup')
  const backupRoot = join(stageRoot(meta.transferId), 'backup', 'originals')
  await ensureRealDirectory(backupRoot)
  for (const item of meta.promotionPlan) {
    if (!item.hadOriginal) continue
    const backupPath = backupPathFor(meta, item)
    if (meta.state === 'validated') {
      const livePath = livePathFor(item)
      await ensureRealDirectory(dirname(backupPath))
      try {
        await copyFile(livePath, backupPath, constants.COPYFILE_EXCL)
        await chmodIfNeeded(backupPath, item.mode ?? 0o600)
        const backup = await open(backupPath, 'r')
        try {
          await backup.sync()
        } finally {
          await backup.close()
        }
        await syncDirectory(dirname(backupPath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    await verifyInventoryFile(backupPath, item, `recovery backup for ${item.path}`)
  }

  if (meta.state === 'validated') {
    for (const item of meta.promotionPlan)
      await verifyInventoryFile(livePathFor(item), item, `live original ${item.path}`)
    await crashPoint(ctx, 'after-backup')
    meta.state = 'promoting'
    await writeJson(metaPath(meta.transferId), meta)
  } else if (meta.state !== 'promoting') {
    fail('uncertain-commit', `transfer cannot resume promotion from ${meta.state}`)
  }
  await crashPoint(ctx, 'after-promoting-journal')
}

async function installedFileMatches(
  path: string,
  expected: ServerTransferManifestEntry,
): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return false
  if (info.isSymbolicLink() || !info.isFile())
    fail('unsafe-path', `target path is not a regular file: ${expected.path}`)
  return (
    info.size === expected.size &&
    (info.mode & 0o777) === expected.mode &&
    (await fileDigest(path)) === expected.sha256
  )
}

async function installPortableFile(
  meta: StageMeta,
  entry: ServerTransferManifestEntry,
): Promise<void> {
  const source = stagePath(meta.transferId, entry.path)
  const destination = statePath(entry.path)
  await assertRealParents(stateDir(), entry.path)
  if (await installedFileMatches(destination, entry)) return

  await ensureRealDirectory(dirname(destination))
  const temp = join(
    dirname(destination),
    `.${basename(destination)}.server-transfer-${meta.transferId}.tmp`,
  )
  try {
    await copyFile(source, temp, constants.COPYFILE_EXCL)
    await chmodIfNeeded(temp, entry.mode)
    const installed = await open(temp, 'r')
    try {
      await installed.sync()
    } finally {
      await installed.close()
    }
    await syncDirectory(dirname(temp))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await installedFileMatches(temp, entry)))
      fail('uncertain-commit', `stale install candidate conflicts for ${entry.path}`)
  }
  await rename(temp, destination)
  await syncDirectory(dirname(destination))
}

async function persistTargetConfig(publicUrl: string): Promise<void> {
  applySetup({ mode: 'server', publicUrl })
  const path = configPath()
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(path))
}

function exactServingProof(
  expected: ServerTransferServingProof,
  observed: ServerTransferServingProof,
): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    fail('identity-mismatch', 'serving callback proof does not match the promoted transfer')
}

async function promote(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'serverTransferPromoteRequest' }>,
): Promise<ServerTransferResultMessage> {
  const checked = validatePublicUrl(msg.publicUrl.trim())
  if (!checked.ok) fail('invalid-request', checked.error)
  await acquireLock(msg.transferId)
  const meta = await readRequestMeta(msg.transferId)
  if (meta.manifestDigest !== msg.manifestDigest)
    fail('conflicting-digest', 'manifest digest mismatch')
  if (meta.targetMachineId !== ctx.machineId)
    fail('identity-mismatch', 'transfer target identity changed')
  const promotion = {
    idempotencyKey: msg.idempotencyKey,
    publicUrl: checked.normalized,
    targetMode: msg.targetMode,
  } as const

  if (meta.state === 'promoted') {
    if (JSON.stringify(meta.promotion) !== JSON.stringify(promotion))
      fail('conflicting-digest', 'promotion idempotency key or input conflicts')
    if (!meta.servingProof) fail('uncertain-commit', 'promoted transfer is missing serving proof')
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'promote', {
      ok: true,
      state: 'promoted',
      manifestDigest: meta.manifestDigest,
      publicUrl: meta.publicUrl,
      acknowledged: meta.acknowledged,
      proof: meta.proof,
      servingProof: meta.servingProof,
      idempotent: true,
    })
  }
  if (meta.state === 'uncertain') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'promote', {
      ok: false,
      state: 'uncertain',
      manifestDigest: meta.manifestDigest,
      publicUrl: meta.publicUrl,
      proof: meta.proof,
      servingProof: meta.servingProof,
      errorCode: 'uncertain-commit',
      error: 'transfer requires recovery',
    })
  }
  if ((meta.state !== 'validated' && meta.state !== 'promoting') || !meta.proof)
    fail('invalid-request', `transfer is not validated: ${meta.state}`)
  if (meta.promotion && JSON.stringify(meta.promotion) !== JSON.stringify(promotion))
    fail('conflicting-digest', 'promotion idempotency key or input conflicts')

  meta.promotion = promotion
  meta.publicUrl = checked.normalized
  meta.promotionPlan ??= await buildPromotionInventory(meta)
  await writeJson(metaPath(msg.transferId), meta)

  try {
    await persistRecoveryBackups(ctx, meta)
    for (const entry of meta.manifest.files) await installPortableFile(meta, entry)
    await crashPoint(ctx, 'after-install-before-config')

    await persistTargetConfig(checked.normalized)
    await crashPoint(ctx, 'after-config-before-health')

    const expected: ServerTransferServingProof = {
      ...meta.proof,
      publicUrl: checked.normalized,
      health: 'serving',
    }
    if (!ctx.restartAfterTransfer) fail('uncertain-commit', 'target has no serving health callback')
    const observed = ServerTransferServingProof.parse(await ctx.restartAfterTransfer(expected))
    exactServingProof(expected, observed)
    await crashPoint(ctx, 'after-health-before-proof')

    meta.servingProof = observed
    meta.state = 'promoted'
    await writeJson(metaPath(msg.transferId), meta)
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'promote', {
      ok: true,
      state: 'promoted',
      manifestDigest: meta.manifestDigest,
      publicUrl: meta.publicUrl,
      proof: meta.proof,
      servingProof: meta.servingProof,
      idempotent: false,
    })
  } catch (error) {
    if (error instanceof SimulatedPromotionCrash) throw error
    if (meta.state === 'promoting') {
      meta.state = 'uncertain'
      await writeJson(metaPath(msg.transferId), meta).catch(() => {})
      await releaseLock(msg.transferId)
      return result(msg.requestId, msg.transferId, 'promote', {
        ok: false,
        state: 'uncertain',
        manifestDigest: meta.manifestDigest,
        publicUrl: meta.publicUrl,
        proof: meta.proof,
        servingProof: meta.servingProof,
        errorCode: 'uncertain-commit',
        error: error instanceof Error ? error.message : 'promotion requires recovery',
      })
    }
    throw error
  }
}

async function chmodIfNeeded(path: string, mode: number): Promise<void> {
  await chmod(path, mode & 0o777)
}

async function abort(
  msg: Extract<ControlMessage, { type: 'serverTransferAbortRequest' }>,
): Promise<ServerTransferResultMessage> {
  await acquireLock(msg.transferId)
  const meta = await readMeta(msg.transferId).catch(() => undefined)
  if (meta && meta.manifestDigest !== msg.manifestDigest)
    fail('conflicting-digest', 'abort manifest digest does not own this stage')
  if (meta?.state === 'promoted' || meta?.state === 'promoting' || meta?.state === 'uncertain') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'abort', {
      ok: false,
      state: meta.state,
      manifestDigest: meta.manifestDigest,
      proof: meta.proof,
      servingProof: meta.servingProof,
      cleaned: false,
      errorCode: meta.state === 'promoted' ? 'committed' : 'uncertain-commit',
      error: 'a promoted or uncertain transfer cannot be aborted',
    })
  }
  await rm(stageRoot(msg.transferId), { recursive: true, force: true })
  await ensureRealDirectory(root())
  await syncDirectory(root())
  await releaseLock(msg.transferId)
  return result(msg.requestId, msg.transferId, 'abort', {
    ok: true,
    state: 'aborted',
    manifestDigest: msg.manifestDigest,
    cleaned: true,
    idempotent: meta === undefined,
  })
}

async function acknowledge(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'serverTransferAcknowledgeRequest' }>,
): Promise<ServerTransferResultMessage> {
  await acquireLock(msg.transferId)
  const meta = await readRequestMeta(msg.transferId)
  if (meta.manifestDigest !== msg.manifestDigest)
    fail('conflicting-digest', 'acknowledgement manifest digest does not own this transfer')
  if (meta.targetMachineId !== ctx.machineId)
    fail('identity-mismatch', 'transfer target identity changed')
  if (meta.state !== 'promoted' || !meta.servingProof)
    fail('refused', 'only a promoted transfer with durable serving proof can be acknowledged')
  if (!ctx.retireAfterTransfer) fail('refused', 'target daemon has no retirement callback')

  const idempotent = meta.acknowledged === true
  if (!idempotent) {
    meta.acknowledged = true
    await writeJson(metaPath(msg.transferId), meta)
  }
  return result(msg.requestId, msg.transferId, 'acknowledge', {
    ok: true,
    state: 'promoted',
    manifestDigest: meta.manifestDigest,
    publicUrl: meta.publicUrl,
    proof: meta.proof,
    servingProof: meta.servingProof,
    acknowledged: true,
    idempotent,
  })
}

async function status(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'serverTransferStatusRequest' }>,
): Promise<ServerTransferResultMessage> {
  let id = msg.transferId
  if (!id) {
    const candidates = await readdir(root()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })
    const metas = await Promise.all(
      candidates
        .filter((candidate) => /^[0-9a-f-]{36}$/i.test(candidate))
        .map(async (candidate) => ({
          id: candidate,
          meta: await readMeta(candidate).catch(() => undefined),
          info: await stat(metaPath(candidate)).catch(() => undefined),
        })),
    )
    metas.sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))
    id = metas.find(
      (candidate) =>
        candidate.meta !== undefined &&
        candidate.info !== undefined &&
        (!msg.manifestDigest || candidate.meta.manifestDigest === msg.manifestDigest),
    )?.id
  }
  if (!id)
    return {
      type: 'serverTransferResult',
      requestId: msg.requestId,
      operation: 'status',
      ok: true,
      state: 'idle',
    }
  const meta = await readRequestMeta(id)
  if (meta.targetMachineId !== ctx.machineId)
    fail('identity-mismatch', 'transfer target identity changed')
  if (msg.manifestDigest && meta.manifestDigest !== msg.manifestDigest)
    fail('conflicting-digest', 'status manifest digest does not own this stage')
  return result(msg.requestId, id, 'status', {
    ok: meta.state !== 'uncertain' && meta.state !== 'promoting',
    state: meta.state,
    manifestDigest: meta.manifestDigest,
    proof: meta.proof,
    servingProof: meta.servingProof,
    sourceMachineId: meta.sourceMachineId,
    publicUrl: meta.publicUrl,
    acknowledged: meta.acknowledged,
    ...(meta.state === 'uncertain' || meta.state === 'promoting'
      ? { errorCode: 'uncertain-commit' as const, error: 'transfer requires recovery' }
      : {}),
  })
}

async function handle(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: `serverTransfer${string}Request` }>,
): Promise<void> {
  const operation = operationFor(msg.type)
  try {
    const response =
      msg.type === 'serverTransferPrepareRequest'
        ? await prepare(ctx, msg)
        : msg.type === 'serverTransferChunkRequest'
          ? await chunk(msg)
          : msg.type === 'serverTransferValidateRequest'
            ? await validate(ctx, msg)
            : msg.type === 'serverTransferPromoteRequest'
              ? await promote(ctx, msg)
              : msg.type === 'serverTransferAbortRequest'
                ? await abort(msg)
                : msg.type === 'serverTransferAcknowledgeRequest'
                  ? await acknowledge(ctx, msg)
                  : await status(ctx, msg)
    ctx.send(response)
    if (msg.type === 'serverTransferAcknowledgeRequest' && response.ok)
      queueMicrotask(() => {
        void Promise.resolve(ctx.retireAfterTransfer?.()).catch(() => {})
      })
  } catch (error) {
    const id = msg.transferId
    const state = id
      ? await readMeta(id)
          .then((meta) => meta.state)
          .catch(() => 'aborted' as const)
      : ('idle' as const)
    const failure =
      error instanceof ServerTransferError
        ? { code: error.code, message: error.message }
        : { code: 'internal' as const, message: 'internal server-transfer failure' }
    ctx.send({
      type: 'serverTransferResult',
      requestId: msg.requestId,
      ...(id ? { transferId: id } : {}),
      operation,
      ok: false,
      state,
      errorCode: state === 'uncertain' || state === 'promoting' ? 'uncertain-commit' : failure.code,
      error: failure.message,
    })
  } finally {
    if (msg.transferId) await releaseLock(msg.transferId)
  }
}

export const serverTransferHandlers: Pick<
  ControlHandlers,
  | 'serverTransferPrepareRequest'
  | 'serverTransferChunkRequest'
  | 'serverTransferValidateRequest'
  | 'serverTransferPromoteRequest'
  | 'serverTransferAbortRequest'
  | 'serverTransferStatusRequest'
  | 'serverTransferAcknowledgeRequest'
> = {
  serverTransferPrepareRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
  serverTransferChunkRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
  serverTransferValidateRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
  serverTransferPromoteRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
  serverTransferAbortRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
  serverTransferAcknowledgeRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
  serverTransferStatusRequest: (ctx, msg) => {
    void handle(ctx, msg)
  },
}
