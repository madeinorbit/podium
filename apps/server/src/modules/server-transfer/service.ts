import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ServerTransferManifestEntry } from '@podium/protocol'
import { canonicalServerTransferManifest } from '@podium/protocol'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { validatePublicUrl, wssFrom } from '@podium/runtime/setup'

const MAX_BYTES = 512 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const ROOT_FILES = new Set(['podium.db', 'enrollment.ledger'])
const ROOT_DIRS = new Set(['transcripts', 'artifacts', 'uploads'])
export type ServerTransferJournalState =
  | 'idle'
  | 'preparing'
  | 'staged'
  | 'validated'
  | 'source-fenced'
  | 'committing'
  | 'committed'
  | 'commit-uncertain'
  | 'aborted'
  | 'abort-uncertain'
interface Journal {
  version: 1
  transferId: string
  targetMachineId: string
  publicUrl: string
  state: ServerTransferJournalState
  manifestDigest?: string
  createdAt: string
  updatedAt: string
  error?: string
}
interface Reply {
  ok: boolean
  state: string
  error?: string
}
export interface ServerTransferRpc {
  serverTransferPrepare(
    input: {
      transferId: string
      manifest: ServerTransferManifestEntry[]
      manifestDigest: string
      totalBytes: number
    },
    machineId: string,
  ): Promise<Reply>
  serverTransferChunk(
    input: { transferId: string; path: string; offset: number; data: Buffer },
    machineId: string,
  ): Promise<Reply>
  serverTransferValidate(id: string, digest: string, machineId: string): Promise<Reply>
  serverTransferPromote(
    id: string,
    digest: string,
    publicUrl: string,
    machineId: string,
  ): Promise<Reply>
  serverTransferAbort(id: string, reason: string | undefined, machineId: string): Promise<Reply>
}
export interface ServerTransferDeps {
  stateRoot: string
  rpc: ServerTransferRpc
  online(machineId: string): boolean
  sourceMachineId?: string
  checkpoint?: () => void
  fence?: () => Promise<void> | void
  releaseFence?: () => Promise<void> | void
  restartAsDaemon?: (serverUrl: string) => void
  now?: () => Date
}
export interface ServerTransferInput {
  targetMachineId: string
  publicUrl: string
  confirmation: true
}
export interface ServerTransferOutcome {
  ok: boolean
  transferId: string
  state: 'committed' | 'commit-uncertain'
  targetMachineId: string
  publicUrl: string
  error?: string
}
export class ServerTransferError extends Error {
  constructor(
    message: string,
    readonly transferId: string,
    readonly phase: string,
  ) {
    super(message)
    this.name = 'ServerTransferError'
  }
}

const digest = (items: ServerTransferManifestEntry[]) =>
  createHash('sha256').update(canonicalServerTransferManifest(items)).digest('hex')
async function hash(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const part of createReadStream(path)) h.update(part)
  return h.digest('hex')
}
const allowed = (path: string) => {
  const first = path.split('/')[0] ?? ''
  return (
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    (ROOT_FILES.has(path) || (ROOT_DIRS.has(first) && path !== first))
  )
}
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`portable state contains symlink: ${prefix}`)
    if (info.isFile()) {
      if (!allowed(prefix)) throw new Error(`portable path is not allowed: ${prefix}`)
      out.push(prefix)
      return
    }
    if (!info.isDirectory()) throw new Error(`portable path is not regular: ${prefix}`)
    for (const name of (await readdir(absolute)).sort())
      await walk(join(absolute, name), `${prefix}/${name}`)
  }
  for (const name of [...ROOT_FILES, ...ROOT_DIRS]) {
    try {
      const path = join(root, name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`portable root is symlink: ${name}`)
      if (info.isFile()) out.push(name)
      else if (info.isDirectory()) await walk(path, name)
      else throw new Error(`portable root is not regular: ${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return [...new Set(out)].sort()
}
async function makeManifest(root: string): Promise<ServerTransferManifestEntry[]> {
  const items: ServerTransferManifestEntry[] = []
  for (const path of await listFiles(root)) {
    const info = await stat(join(root, path))
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error(`invalid portable file: ${path}`)
    items.push({
      path,
      size: info.size,
      mode: info.mode & 0o777,
      sha256: await hash(join(root, path)),
    })
  }
  if (items.reduce((n, item) => n + item.size, 0) > MAX_BYTES)
    throw new Error('portable state exceeds 512 MiB')
  return items
}
async function sync(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}
async function atomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await sync(tmp)
  await rename(tmp, path)
}
async function journalAt(path: string): Promise<Journal | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Journal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function copySnapshot(
  root: string,
  destination: string,
  items: ServerTransferManifestEntry[],
): Promise<void> {
  for (const item of items) {
    const to = join(destination, item.path)
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    const tmp = `${to}.${process.pid}.tmp`
    await copyFile(join(root, item.path), tmp)
    await sync(tmp)
    await rename(tmp, to)
  }
}
async function changed(root: string, expected: ServerTransferManifestEntry[]): Promise<boolean> {
  const current = await makeManifest(root)
  return (
    digest(current) !== digest(expected) || JSON.stringify(current) !== JSON.stringify(expected)
  )
}
async function upload(
  root: string,
  items: ServerTransferManifestEntry[],
  id: string,
  machineId: string,
  rpc: ServerTransferRpc,
): Promise<void> {
  for (const item of items) {
    let offset = 0
    for await (const part of createReadStream(join(root, item.path), {
      highWaterMark: CHUNK_BYTES,
    })) {
      const data = Buffer.isBuffer(part) ? part : Buffer.from(part)
      const reply = await rpc.serverTransferChunk(
        { transferId: id, path: item.path, offset, data },
        machineId,
      )
      if (!reply.ok) throw new Error(reply.error ?? `target rejected ${item.path}`)
      offset += data.length
    }
    if (offset !== item.size) throw new Error(`snapshot size changed: ${item.path}`)
  }
}
async function abortTarget(
  rpc: ServerTransferRpc,
  id: string,
  machineId: string,
  reason: string,
): Promise<void> {
  const reply = await rpc.serverTransferAbort(id, reason, machineId)
  if (!reply.ok || reply.state !== 'aborted')
    throw new Error(reply.error ?? 'target abort not confirmed')
}

export class ServerTransferService {
  private readonly journalPath: string
  private readonly lockPath: string
  private readonly now: () => Date
  private lockFile: Awaited<ReturnType<typeof open>> | undefined
  constructor(private readonly deps: ServerTransferDeps) {
    const dir = join(deps.stateRoot, '.server-transfer')
    this.journalPath = join(dir, 'journal.json')
    this.lockPath = join(dir, 'source.lock')
    this.now = deps.now ?? (() => new Date())
  }
  private async lock(): Promise<void> {
    if (this.lockFile) throw new Error('a server transfer is already running')
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 })
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }),
          )
          this.lockFile = handle
          return
        } catch (error) {
          await handle.close().catch(() => {})
          await rm(this.lockPath, { force: true })
          throw error
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let owner: { pid?: number } = {}
        try {
          owner = JSON.parse(await readFile(this.lockPath, 'utf8')) as typeof owner
        } catch {
          throw new Error('another transfer is active (lock unreadable)')
        }
        let alive = false
        if (typeof owner.pid === 'number') {
          try {
            process.kill(owner.pid, 0)
            alive = true
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') alive = true
          }
        }
        if (alive) throw new Error('a server transfer is already running')
        await rm(this.lockPath, { force: true })
      }
    }
  }
  private async unlock(): Promise<void> {
    await this.lockFile?.close().catch(() => {})
    this.lockFile = undefined
    await rm(this.lockPath, { force: true })
  }
  private async writeJournal(input: {
    id: string
    machineId: string
    url: string
    state: ServerTransferJournalState
    digest?: string
    error?: string
  }): Promise<void> {
    const old = await journalAt(this.journalPath)
    const sameTransfer = old?.transferId === input.id
    await atomic(this.journalPath, {
      version: 1,
      transferId: input.id,
      targetMachineId: input.machineId,
      publicUrl: input.url,
      state: input.state,
      ...(input.digest
        ? { manifestDigest: input.digest }
        : sameTransfer && old?.manifestDigest
          ? { manifestDigest: old.manifestDigest }
          : {}),
      createdAt: sameTransfer && old?.createdAt ? old.createdAt : this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      ...(input.error ? { error: input.error } : {}),
    } satisfies Journal)
  }
  async transfer(input: ServerTransferInput): Promise<ServerTransferOutcome> {
    if (input.confirmation !== true)
      throw new Error('server transfer requires explicit confirmation')
    const check = validatePublicUrl(input.publicUrl.trim())
    if (this.deps.sourceMachineId === input.targetMachineId)
      throw new Error('target machine is already the server')
    if (!check.ok) throw new Error(check.error)
    if (!this.deps.online(input.targetMachineId)) throw new Error('target machine is offline')
    await this.lock()
    const id = randomUUID()
    const url = check.normalized
    const snapshotRoot = join(this.deps.stateRoot, '.server-transfer', 'snapshots', id)
    let phase: 'preparing' | 'staging' | 'validating' | 'fencing' | 'committing' = 'preparing'
    let journalOwned = false
    let targetMayBeStaged = false
    let fenceHeld = false
    try {
      const old = await journalAt(this.journalPath)
      if (old?.state === 'commit-uncertain' || old?.state === 'abort-uncertain')
        throw new Error('previous transfer is uncertain; recover it before starting another')
      if (old && !['idle', 'aborted', 'committed'].includes(old.state))
        throw new Error(`transfer already in progress: ${old.state}`)
      await this.writeJournal({ id, machineId: input.targetMachineId, url, state: 'preparing' })
      journalOwned = true
      this.deps.checkpoint?.()
      const items = await makeManifest(this.deps.stateRoot)
      const d = digest(items)
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'preparing',
        digest: d,
      })
      await copySnapshot(this.deps.stateRoot, snapshotRoot, items)
      phase = 'staging'
      targetMayBeStaged = true
      const prepared = await this.deps.rpc.serverTransferPrepare(
        {
          transferId: id,
          manifest: items,
          manifestDigest: d,
          totalBytes: items.reduce((n, item) => n + item.size, 0),
        },
        input.targetMachineId,
      )
      if (!prepared.ok || !['staging', 'prepared'].includes(prepared.state))
        throw new Error(prepared.error ?? 'target refused preparation')
      await upload(snapshotRoot, items, id, input.targetMachineId, this.deps.rpc)
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'staged',
        digest: d,
      })
      phase = 'validating'
      const valid = await this.deps.rpc.serverTransferValidate(id, d, input.targetMachineId)
      if (!valid.ok || valid.state !== 'validated')
        throw new Error(valid.error ?? 'target validation failed')
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'validated',
        digest: d,
      })
      if (await changed(this.deps.stateRoot, items))
        throw new Error('source changed during staging; transfer aborted')
      phase = 'fencing'
      this.deps.checkpoint?.()
      fenceHeld = true
      await this.deps.fence?.()
      if (await changed(this.deps.stateRoot, items))
        throw new Error('source changed at fence; transfer aborted')
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'source-fenced',
        digest: d,
      })
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'committing',
        digest: d,
      })
      phase = 'committing'
      const promoted = await this.deps.rpc.serverTransferPromote(id, d, url, input.targetMachineId)
      if (!promoted.ok || promoted.state !== 'promoted') {
        const error = promoted.error ?? 'target promotion was not confirmed'
        await this.writeJournal({
          id,
          machineId: input.targetMachineId,
          url,
          state: 'commit-uncertain',
          digest: d,
          error,
        })
        return {
          ok: false,
          transferId: id,
          state: 'commit-uncertain',
          targetMachineId: input.targetMachineId,
          publicUrl: url,
          error,
        }
      }
      const previous = loadConfig()
      const { publicUrl: _old, ...rest } = previous
      saveConfig({ ...rest, mode: 'daemon', serverUrl: wssFrom(url) })
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'committed',
        digest: d,
      })
      if (this.deps.restartAsDaemon)
        setTimeout(() => this.deps.restartAsDaemon?.(wssFrom(url)), 250)
      return {
        ok: true,
        transferId: id,
        state: 'committed',
        targetMachineId: input.targetMachineId,
        publicUrl: url,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!journalOwned) throw error
      if (phase === 'committing') {
        await this.writeJournal({
          id,
          machineId: input.targetMachineId,
          url,
          state: 'commit-uncertain',
          error: message,
        })
        return {
          ok: false,
          transferId: id,
          state: 'commit-uncertain',
          targetMachineId: input.targetMachineId,
          publicUrl: url,
          error: message,
        }
      }
      if (targetMayBeStaged) {
        try {
          await abortTarget(this.deps.rpc, id, input.targetMachineId, message)
        } catch (abortError) {
          await this.writeJournal({
            id,
            machineId: input.targetMachineId,
            url,
            state: 'abort-uncertain',
            error: `abort not confirmed: ${abortError}`,
          })
          throw new ServerTransferError(
            `transfer failed and abort was not confirmed: ${abortError}`,
            id,
            phase,
          )
        }
      }
      if (fenceHeld) {
        try {
          await this.deps.releaseFence?.()
          fenceHeld = false
        } catch (releaseError) {
          await this.writeJournal({
            id,
            machineId: input.targetMachineId,
            url,
            state: 'abort-uncertain',
            error: `source fence release not confirmed: ${releaseError}`,
          })
          throw new ServerTransferError(
            `transfer failed and source fence release was not confirmed: ${releaseError}`,
            id,
            phase,
          )
        }
      }
      await this.writeJournal({
        id,
        machineId: input.targetMachineId,
        url,
        state: 'aborted',
        error: message,
      })
      throw new ServerTransferError(message, id, phase)
    } finally {
      await this.unlock()
    }
  }
}
