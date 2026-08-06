import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'
import {
  type ControlMessage,
  canonicalServerTransferManifest,
  type ServerTransferManifestEntry,
  type ServerTransferOperation,
  type ServerTransferResultMessage,
} from '@podium/protocol'
import { stateDir } from '@podium/runtime/config'
import { applySetup, validatePublicUrl } from '@podium/runtime/setup'
import type { ControlHandlers, DaemonContext } from './control/context'

const TRANSFER_DIR = '.server-transfer'
const MAX_CHUNK_BYTES = 6 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const PORTABLE_ROOTS = ['transcripts', 'artifacts', 'uploads'] as const

type StageState = 'staging' | 'validated' | 'promoted' | 'aborted' | 'uncertain'
interface StageMeta {
  version: 1
  transferId: string
  manifest: ServerTransferManifestEntry[]
  manifestDigest: string
  totalBytes: number
  received: Record<string, number>
  state: StageState
  publicUrl?: string
}

let heldLock: { transferId: string; handle: Awaited<ReturnType<typeof open>> } | undefined

function operationFor(type: ControlMessage['type']): ServerTransferOperation {
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
    default:
      throw new Error(`not a server-transfer request: ${type}`)
  }
}

function root(): string {
  return join(stateDir(), TRANSFER_DIR)
}

function stageRoot(transferId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(transferId)) throw new Error('invalid transfer id')
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
    throw new Error(`unsafe transfer path: ${path}`)
  }
  const allowed =
    path === 'podium.db' ||
    path === 'enrollment.ledger' ||
    PORTABLE_ROOTS.some((prefix) => path.startsWith(`${prefix}/`))
  if (!allowed || normalize(path) !== path) throw new Error(`path is not portable: ${path}`)
}

function stagePath(transferId: string, path: string): string {
  assertPortablePath(path)
  const base = resolve(stageRoot(transferId))
  const candidate = resolve(base, path)
  if (candidate !== base && !candidate.startsWith(`${base}/`))
    throw new Error(`transfer path escaped stage: ${path}`)
  return candidate
}

function statePath(path: string): string {
  assertPortablePath(path)
  const base = resolve(stateDir())
  const candidate = resolve(base, path)
  if (candidate !== base && !candidate.startsWith(`${base}/`))
    throw new Error(`transfer path escaped state root: ${path}`)
  return candidate
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  const handle = await open(temp, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

async function readMeta(transferId: string): Promise<StageMeta> {
  const parsed = JSON.parse(await readFile(metaPath(transferId), 'utf8')) as StageMeta
  if (parsed.version !== 1 || parsed.transferId !== transferId)
    throw new Error('invalid transfer journal')
  return parsed
}

async function acquireLock(transferId: string): Promise<void> {
  if (heldLock?.transferId === transferId) return
  if (heldLock) throw new Error(`another transfer is active: ${heldLock.transferId}`)
  await mkdir(root(), { recursive: true })
  for (;;) {
    try {
      const handle = await open(lockPath(), 'wx', 0o600)
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, transferId, startedAt: Date.now() }),
      )
      heldLock = { transferId, handle }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: { pid?: number; transferId?: string } = {}
      try {
        owner = JSON.parse(await readFile(lockPath(), 'utf8')) as typeof owner
      } catch {
        throw new Error('another transfer is active (lock unreadable)')
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
      if (alive) throw new Error(`another transfer is active: ${owner.transferId ?? 'unknown'}`)
      await rm(lockPath(), { force: true })
    }
  }
}

async function releaseLock(transferId: string): Promise<void> {
  if (heldLock?.transferId !== transferId) return
  await heldLock.handle.close().catch(() => {})
  heldLock = undefined
  await rm(lockPath(), { force: true })
}

function digestEntries(entries: ServerTransferManifestEntry[]): string {
  return createHash('sha256').update(canonicalServerTransferManifest(entries)).digest('hex')
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    hash.update(chunk)
  return hash.digest('hex')
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
  manifest: ServerTransferManifestEntry[],
  manifestDigest: string,
  totalBytes: number,
): void {
  if (manifest.length > 20_000) throw new Error('transfer manifest is too large')
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('transfer is too large')
  const sorted = [...manifest].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (JSON.stringify(sorted) !== JSON.stringify(manifest))
    throw new Error('manifest must be sorted')
  const seen = new Set<string>()
  let total = 0
  for (const entry of manifest) {
    assertPortablePath(entry.path)
    if (seen.has(entry.path)) throw new Error(`duplicate manifest path: ${entry.path}`)
    seen.add(entry.path)
    total += entry.size
    if (total > MAX_TOTAL_BYTES) throw new Error('transfer is too large')
  }
  if (total !== totalBytes) throw new Error('manifest total does not match totalBytes')
  if (digestEntries(manifest) !== manifestDigest) throw new Error('manifest digest mismatch')
}

async function prepare(
  msg: Extract<ControlMessage, { type: 'serverTransferPrepareRequest' }>,
): Promise<ServerTransferResultMessage> {
  validateManifest(msg.manifest, msg.manifestDigest, msg.totalBytes)
  await acquireLock(msg.transferId)
  try {
    const existing = await readMeta(msg.transferId).catch(() => undefined)
    if (existing) {
      if (existing.manifestDigest !== msg.manifestDigest || existing.totalBytes !== msg.totalBytes)
        throw new Error('transfer id is already used for a different manifest')
      return result(msg.requestId, msg.transferId, 'prepare', {
        ok: existing.state !== 'uncertain',
        state: existing.state,
        manifestDigest: existing.manifestDigest,
        receivedBytes: Object.values(existing.received).reduce((sum, n) => sum + n, 0),
        ...(existing.state === 'uncertain' ? { error: 'transfer requires recovery' } : {}),
      })
    }
    const dir = stageRoot(msg.transferId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    for (const entry of msg.manifest) {
      const path = stagePath(msg.transferId, entry.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const handle = await open(path, 'w', entry.mode & 0o777)
      try {
        await handle.truncate(entry.size)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const meta: StageMeta = {
      version: 1,
      transferId: msg.transferId,
      manifest: msg.manifest,
      manifestDigest: msg.manifestDigest,
      totalBytes: msg.totalBytes,
      received: Object.fromEntries(msg.manifest.map((entry) => [entry.path, 0])),
      state: 'staging',
    }
    await writeJson(metaPath(msg.transferId), meta)
    return result(msg.requestId, msg.transferId, 'prepare', {
      ok: true,
      state: 'staging',
      manifestDigest: msg.manifestDigest,
      receivedBytes: 0,
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
  const meta = await readMeta(msg.transferId)
  if (meta.state !== 'staging') {
    if (meta.state === 'promoted') {
      await releaseLock(msg.transferId)
      return result(msg.requestId, msg.transferId, 'chunk', {
        ok: true,
        state: 'promoted',
        path: msg.path,
        offset: msg.offset,
      })
    }
    throw new Error(`transfer is not staging: ${meta.state}`)
  }
  const entry = meta.manifest.find((candidate) => candidate.path === msg.path)
  if (!entry) throw new Error(`path is not in manifest: ${msg.path}`)
  const data = Buffer.from(msg.data, 'base64')
  if (data.length === 0 || data.length > MAX_CHUNK_BYTES)
    throw new Error('invalid transfer chunk size')
  const received = meta.received[msg.path] ?? 0
  if (msg.offset === received) {
    if (msg.offset + data.length > entry.size) throw new Error('transfer chunk exceeds file size')
    const handle = await open(stagePath(msg.transferId, msg.path), 'r+')
    try {
      await handle.write(data, 0, data.length, msg.offset)
      await handle.sync()
    } finally {
      await handle.close()
    }
    meta.received[msg.path] = received + data.length
    await writeJson(metaPath(msg.transferId), meta)
    return result(msg.requestId, msg.transferId, 'chunk', {
      ok: true,
      state: 'staging',
      path: msg.path,
      offset: msg.offset,
      receivedBytes: data.length,
    })
  }
  if (msg.offset < received && msg.offset + data.length <= received) {
    const handle = await open(stagePath(msg.transferId, msg.path), 'r')
    const existing = Buffer.alloc(data.length)
    try {
      await handle.read(existing, 0, data.length, msg.offset)
    } finally {
      await handle.close()
    }
    if (existing.equals(data))
      return result(msg.requestId, msg.transferId, 'chunk', {
        ok: true,
        state: 'staging',
        path: msg.path,
        offset: msg.offset,
        receivedBytes: data.length,
      })
  }
  throw new Error(
    `non-contiguous transfer chunk for ${msg.path}: expected ${received}, got ${msg.offset}`,
  )
}

async function validate(
  msg: Extract<ControlMessage, { type: 'serverTransferValidateRequest' }>,
): Promise<ServerTransferResultMessage> {
  await acquireLock(msg.transferId)
  const meta = await readMeta(msg.transferId)
  if (meta.manifestDigest !== msg.manifestDigest) throw new Error('manifest digest mismatch')
  if (meta.state === 'promoted') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'validate', {
      ok: true,
      state: 'promoted',
      manifestDigest: meta.manifestDigest,
    })
  }
  if (meta.state === 'uncertain') throw new Error('transfer requires recovery')
  for (const entry of meta.manifest) {
    if ((meta.received[entry.path] ?? 0) !== entry.size)
      throw new Error(`incomplete transfer file: ${entry.path}`)
    const path = stagePath(msg.transferId, entry.path)
    const info = await stat(path)
    if (!info.isFile() || info.size !== entry.size || (info.mode & 0o777) !== entry.mode)
      throw new Error(`staged file metadata mismatch: ${entry.path}`)
    if ((await fileDigest(path)) !== entry.sha256)
      throw new Error(`staged file digest mismatch: ${entry.path}`)
  }
  meta.state = 'validated'
  await writeJson(metaPath(msg.transferId), meta)
  return result(msg.requestId, msg.transferId, 'validate', {
    ok: true,
    state: 'validated',
    manifestDigest: meta.manifestDigest,
  })
}

async function rollback(meta: StageMeta, moved: string[]): Promise<void> {
  const backupRoot = join(stageRoot(meta.transferId), 'backup')
  for (const path of [...moved].reverse()) {
    const destination = statePath(path)
    await rm(destination, { force: true })
    const backup = join(backupRoot, path)
    try {
      await stat(backup)
      await mkdir(dirname(destination), { recursive: true })
      await rename(backup, destination)
    } catch {
      // No backup means the destination did not exist before this transfer.
    }
  }
}

async function promote(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'serverTransferPromoteRequest' }>,
): Promise<ServerTransferResultMessage> {
  const checked = validatePublicUrl(msg.publicUrl.trim())
  if (!checked.ok) throw new Error(checked.error)
  await acquireLock(msg.transferId)
  const meta = await readMeta(msg.transferId)
  if (meta.manifestDigest !== msg.manifestDigest) throw new Error('manifest digest mismatch')
  if (meta.state === 'promoted') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'promote', {
      ok: true,
      state: 'promoted',
      manifestDigest: meta.manifestDigest,
    })
  }
  if (meta.state === 'uncertain') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'promote', {
      ok: false,
      state: 'uncertain',
      error: 'transfer requires recovery',
    })
  }
  if (meta.state !== 'validated') throw new Error(`transfer is not validated: ${meta.state}`)
  const backupRoot = join(stageRoot(msg.transferId), 'backup')
  const moved: string[] = []
  let promotionStarted = false
  try {
    for (const entry of meta.manifest) {
      moved.push(entry.path)
      const source = stagePath(msg.transferId, entry.path)
      const destination = statePath(entry.path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const backup = join(backupRoot, entry.path)
      try {
        const existing = await stat(destination)
        if (!existing.isFile()) throw new Error(`target path is not a regular file: ${entry.path}`)
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
        await rename(destination, backup)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(source, destination)
      await (await open(destination, 'r')).close()
      await chmodIfNeeded(destination, entry.mode)
    }
    promotionStarted = true
    applySetup({ mode: 'server', publicUrl: checked.normalized })
    await ctx.restartAfterTransfer?.()
    meta.publicUrl = checked.normalized
    meta.state = 'promoted'
    await writeJson(metaPath(msg.transferId), meta)
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'promote', {
      ok: true,
      state: 'promoted',
      manifestDigest: meta.manifestDigest,
    })
  } catch (error) {
    if (promotionStarted) {
      meta.state = 'uncertain'
      await writeJson(metaPath(msg.transferId), meta).catch(() => {})
      await releaseLock(msg.transferId)
      return result(msg.requestId, msg.transferId, 'promote', {
        ok: false,
        state: 'uncertain',
        error: 'promotion reached configuration handoff',
      })
    }
    try {
      await rollback(meta, moved)
      meta.state = 'staging'
      await writeJson(metaPath(msg.transferId), meta)
    } catch (rollbackError) {
      meta.state = 'uncertain'
      await writeJson(metaPath(msg.transferId), meta).catch(() => {})
      await releaseLock(msg.transferId)
      return result(msg.requestId, msg.transferId, 'promote', {
        ok: false,
        state: 'uncertain',
        error: `promotion failed and rollback failed: ${rollbackError}`,
      })
    }
    await releaseLock(msg.transferId)
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
  if (meta?.state === 'promoted' || meta?.state === 'uncertain') {
    await releaseLock(msg.transferId)
    return result(msg.requestId, msg.transferId, 'abort', {
      ok: false,
      state: meta.state === 'uncertain' ? 'uncertain' : 'promoted',
      error: 'a promoted or uncertain transfer cannot be aborted',
    })
  }
  await rm(stageRoot(msg.transferId), { recursive: true, force: true })
  await releaseLock(msg.transferId)
  return result(msg.requestId, msg.transferId, 'abort', { ok: true, state: 'aborted' })
}

async function handle(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: `serverTransfer${string}Request` }>,
): Promise<void> {
  const operation = operationFor(msg.type)
  try {
    const response =
      msg.type === 'serverTransferPrepareRequest'
        ? await prepare(msg)
        : msg.type === 'serverTransferChunkRequest'
          ? await chunk(msg)
          : msg.type === 'serverTransferValidateRequest'
            ? await validate(msg)
            : msg.type === 'serverTransferPromoteRequest'
              ? await promote(ctx, msg)
              : await abort(msg)
    ctx.send(response)
  } catch (error) {
    const state = await readMeta(msg.transferId)
      .then((meta) => meta.state)
      .catch(() => 'aborted' as const)
    if (operation === 'promote' && state !== 'aborted') {
      ctx.send(
        result(msg.requestId, msg.transferId, operation, {
          ok: false,
          state: 'uncertain',
          error: String(error),
        }),
      )
    } else {
      ctx.send(
        result(msg.requestId, msg.transferId, operation, {
          ok: false,
          state,
          error: String(error),
        }),
      )
    }
  } finally {
    await releaseLock(msg.transferId)
  }
}

export const serverTransferHandlers: Pick<
  ControlHandlers,
  | 'serverTransferPrepareRequest'
  | 'serverTransferChunkRequest'
  | 'serverTransferValidateRequest'
  | 'serverTransferPromoteRequest'
  | 'serverTransferAbortRequest'
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
}
