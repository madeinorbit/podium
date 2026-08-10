import { createHash } from 'node:crypto'
import { canonicalServerTransferManifest } from '@podium/protocol'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rename, rm, statfs } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import {
  SERVER_TRANSFER_FORMAT_VERSION,
  type ServerTransferManifest,
  type ServerTransferManifestBody,
  type ServerTransferManifestEntry,
} from './types'

const ROOT_FILES = ['podium.db', 'enrollment.ledger'] as const
const ROOT_DIRECTORIES = ['transcripts', 'artifacts', 'uploads'] as const
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024
export const TRANSFER_SPACE_MARGIN_BYTES = 64 * 1024 * 1024

export function isSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/')
  ) {
    return false
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false
  }
  const first = segments[0]
  return (
    ROOT_FILES.includes(path as (typeof ROOT_FILES)[number]) ||
    (segments.length > 1 && ROOT_DIRECTORIES.includes(first as (typeof ROOT_DIRECTORIES)[number]))
  )
}

async function regularFiles(stateRoot: string): Promise<string[]> {
  const result: string[] = []
  const walk = async (absolute: string, portablePath: string): Promise<void> => {
    const info = await lstat(absolute)
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error(`portable state contains an unsafe file: ${portablePath}`)
    }
    if (info.isFile()) {
      if (!isSafeRelativePath(portablePath)) {
        throw new Error(`portable state path is unsafe: ${portablePath}`)
      }
      result.push(portablePath)
      return
    }
    for (const name of (await readdir(absolute)).sort()) {
      await walk(join(absolute, name), posix.join(portablePath, name))
    }
  }

  for (const name of ROOT_FILES) {
    try {
      const info = await lstat(join(stateRoot, name))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} is not a regular file`)
      result.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`portable state is missing required file: ${name}`)
      }
      throw error
    }
  }
  for (const name of ROOT_DIRECTORIES) {
    try {
      await walk(join(stateRoot, name), name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return result.sort()
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function snapshotEntry(
  stateRoot: string,
  packageDir: string,
  portablePath: string,
): Promise<ServerTransferManifestEntry> {
  if (!isSafeRelativePath(portablePath)) throw new Error(`unsafe portable path: ${portablePath}`)
  const source = join(stateRoot, ...portablePath.split('/'))
  const sourceRelative = relative(stateRoot, source)
  if (sourceRelative.startsWith(`..${sep}`) || sourceRelative === '..') {
    throw new Error(`portable path escapes state root: ${portablePath}`)
  }
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`portable state is not a regular file: ${portablePath}`)
  }
  if (before.size > MAX_TRANSFER_BYTES)
    throw new Error(`portable file is too large: ${portablePath}`)

  const destination = join(packageDir, ...portablePath.split('/'))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}.tmp`
  await copyFile(source, temporary, constants.COPYFILE_EXCL)
  try {
    await syncFile(temporary)
    const after = await lstat(source)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`portable source changed while snapshotting: ${portablePath}`)
    }
    await rename(temporary, destination)
    await syncDirectory(dirname(destination))
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }

  return {
    path: portablePath,
    size: before.size,
    mode: before.mode & 0o777,
    sha256: await sha256(destination),
  }
}

export function canonicalManifestBody(body: ServerTransferManifestBody): string {
  return canonicalServerTransferManifest(body)
}

export function manifestWithDigest(body: ServerTransferManifestBody): ServerTransferManifest {
  return {
    ...body,
    files: [...body.files].sort((left, right) => left.path.localeCompare(right.path)),
    digest: createHash('sha256').update(canonicalManifestBody(body)).digest('hex'),
  }
}

export async function estimatePortableBytes(stateRoot: string): Promise<number> {
  let total = 0
  for (const path of await regularFiles(stateRoot)) {
    total += (await lstat(join(stateRoot, ...path.split('/')))).size
    if (total > MAX_TRANSFER_BYTES) throw new Error('portable state exceeds the transfer limit')
  }
  return total
}

export async function assertSnapshotCapacity(
  stateRoot: string,
  portableBytes: number,
  availableBytes?: number,
): Promise<void> {
  const available =
    availableBytes ?? (await statfs(stateRoot)).bavail * (await statfs(stateRoot)).bsize
  const required = portableBytes * 2 + TRANSFER_SPACE_MARGIN_BYTES
  if (available < required) {
    throw new Error(`snapshot requires ${required} bytes but only ${available} are available`)
  }
}

export async function createPortableSnapshot(input: {
  stateRoot: string
  packageDir: string
  transferId: string
  sourceInstanceId: string
  sourceMachineId: string
  targetMachineId: string
  sourceFeedId: string
  sourceFeedEpoch: string
  sourceApplicationVersion: string
  sourceSchemaVersion: string
  checkpoint(): void | Promise<void>
}): Promise<ServerTransferManifest> {
  await input.checkpoint()
  await rm(input.packageDir, { recursive: true, force: true })
  await mkdir(input.packageDir, { recursive: true, mode: 0o700 })
  const files: ServerTransferManifestEntry[] = []
  for (const path of await regularFiles(input.stateRoot)) {
    files.push(await snapshotEntry(input.stateRoot, input.packageDir, path))
  }
  const packageBytes = files.reduce((sum, entry) => sum + entry.size, 0)
  if (packageBytes > MAX_TRANSFER_BYTES)
    throw new Error('portable state exceeds the transfer limit')
  await syncDirectory(input.packageDir)
  return manifestWithDigest({
    formatVersion: SERVER_TRANSFER_FORMAT_VERSION,
    transferId: input.transferId,
    sourceInstanceId: input.sourceInstanceId,
    sourceMachineId: input.sourceMachineId,
    targetMachineId: input.targetMachineId,
    sourceFeedId: input.sourceFeedId,
    sourceFeedEpoch: input.sourceFeedEpoch,
    appVersion: input.sourceApplicationVersion,
    schemaVersion: input.sourceSchemaVersion,
    packageBytes,
    files,
  })
}

