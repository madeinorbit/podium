import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, inflateRaw } from 'node:zlib'

const unzipGzip = promisify(gunzip)
const unzipDeflate = promisify(inflateRaw)
const MAX_MEMBER_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024

export type ReleaseArchiveFormat = 'tar.gz' | 'zip'

interface ArchiveEntry {
  name: string
  directory: boolean
  executable: boolean
  bytes: Buffer
}

/**
 * Write one named regular member to a fixed basename in the supplied release
 * folder. No archive path is ever used as an output path; links, traversal and
 * oversized members are refused. The destination must not already exist.
 */
export async function extractReleaseFile(
  archive: string,
  format: ReleaseArchiveFormat,
  member: string,
  dir: string,
  executable: string,
): Promise<void> {
  safeName(executable)
  if (executable.includes('/')) invalid()
  if ((await stat(archive)).size > MAX_ARCHIVE_BYTES) invalid()
  const binary = await releaseArchiveMember(await readFile(archive), format, member)
  await writeFile(join(dir, executable), binary, { flag: 'wx', mode: 0o755 })
}

/** Decode a named member without extracting any vendor-controlled path. */
export async function releaseArchiveMember(
  archive: Buffer,
  format: ReleaseArchiveFormat,
  member: string,
): Promise<Buffer> {
  safeName(member)
  const entries = await archiveEntries(archive, format)
  const matches = entries.filter((entry) => entry.name === member)
  const entry = matches[0]
  if (matches.length !== 1 || !entry || entry.directory || !entry.bytes.length) invalid()
  return entry.bytes
}

/**
 * Keep a standalone bundle's resources beside its executable. Validate the
 * whole archive before writing, then create a fresh directory under `dir`.
 * Links, duplicate names and entries outside that directory are refused.
 */
export async function extractReleaseDirectory(
  archive: string,
  format: ReleaseArchiveFormat,
  member: string,
  dir: string,
): Promise<void> {
  safeName(member)
  if (member.includes('/')) invalid()
  if ((await stat(archive)).size > MAX_ARCHIVE_BYTES) invalid()
  const entries = await archiveEntries(await readFile(archive), format)
  const names = new Set<string>()
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, '')
    if (
      (name !== member && !name.startsWith(`${member}/`)) ||
      (name === member && !entry.directory) ||
      names.has(name)
    )
      invalid()
    names.add(name)
  }
  if (!entries.some((entry) => !entry.directory)) invalid()
  // Non-recursive: an existing directory or symlink cannot redirect writes.
  await mkdir(join(dir, member), { mode: 0o755 })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.directory) await mkdir(path, { recursive: true, mode: 0o755 })
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 })
    }
  }
}

/** Keep an archive with several root entries together in one fresh bundle. */
export async function extractReleaseBundle(
  archive: string,
  format: ReleaseArchiveFormat,
  dir: string,
  bundle: string,
): Promise<void> {
  safeName(bundle)
  if (bundle.includes('/')) invalid()
  if ((await stat(archive)).size > MAX_ARCHIVE_BYTES) invalid()
  const entries = await archiveEntries(await readFile(archive), format)
  const names = new Set<string>()
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, '')
    if (names.has(name)) invalid()
    names.add(name)
  }
  if (!entries.some((entry) => !entry.directory)) invalid()
  const root = join(dir, bundle)
  await mkdir(root, { mode: 0o755 })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.directory) await mkdir(path, { recursive: true, mode: 0o755 })
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await writeFile(path, entry.bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 })
    }
  }
}

async function archiveEntries(
  archive: Buffer,
  format: ReleaseArchiveFormat,
): Promise<ArchiveEntry[]> {
  if (archive.length > MAX_ARCHIVE_BYTES) invalid()
  return format === 'tar.gz'
    ? tarEntries(await unzipGzip(archive, { maxOutputLength: MAX_ARCHIVE_BYTES }))
    : zipEntries(archive)
}

function invalid(): never {
  throw new Error('Release archive has an invalid, linked, missing or oversized regular member')
}

function safeName(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.startsWith('/') ||
    name
      .replace(/\/$/, '')
      .split('/')
      .some((part) => !part || part === '..' || part === '.')
  )
    invalid()
}

function text(bytes: Buffer): string {
  return bytes.toString('utf8').split('\0')[0] ?? ''
}

function octal(bytes: Buffer): number {
  const value = text(bytes).trim()
  if (!/^[0-7]+$/.test(value)) invalid()
  return Number.parseInt(value, 8)
}

function tarEntries(archive: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let offset = 0
  let longName: string | undefined
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0)
    if (checksum !== octal(header.subarray(148, 156))) invalid()
    const prefix = text(header.subarray(345, 500))
    const headerName = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`
    const size = octal(header.subarray(124, 136))
    const type = header[156]
    const end = offset + 512 + size
    if (!Number.isSafeInteger(size) || size > MAX_MEMBER_BYTES || end > archive.length) invalid()
    const bytes = archive.subarray(offset + 512, end)
    offset += 512 + Math.ceil(size / 512) * 512
    // GNU tar emits a name record immediately before paths over 100 bytes.
    // It is metadata, never an extracted member or a link. Validate the full
    // effective name with the same checks as every ordinary path.
    if (type === 76) {
      if (
        longName !== undefined ||
        headerName !== '././@LongLink' ||
        size < 2 ||
        size > 4096 ||
        bytes[size - 1] !== 0 ||
        bytes.subarray(0, -1).includes(0)
      )
        invalid()
      longName = bytes.subarray(0, -1).toString('utf8')
      safeName(longName)
      continue
    }
    const name = longName ?? headerName
    longName = undefined
    safeName(name)
    const regular = type === 0 || type === 48
    if (!regular && type !== 53) invalid()
    if ((!regular && size !== 0) || (regular && name.endsWith('/'))) invalid()
    entries.push({
      name,
      directory: !regular,
      executable: (octal(header.subarray(100, 108)) & 0o111) !== 0,
      bytes,
    })
  }
  if (
    longName !== undefined ||
    !entries.length ||
    archive.subarray(offset).some((byte) => byte !== 0)
  )
    invalid()
  return entries
}

/** Central directory sizes also cover ZIP members using data descriptors. */
async function zipEntries(archive: Buffer): Promise<ArchiveEntry[]> {
  let end = archive.length - 22
  const first = Math.max(0, end - 65535)
  while (end >= first) {
    if (
      archive.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + archive.readUInt16LE(end + 20) === archive.length
    )
      break
    end--
  }
  if (end < first) invalid()
  let central = archive.readUInt32LE(end + 16)
  const centralStart = central
  const count = archive.readUInt16LE(end + 10)
  // Ordinary single-disk ZIP. Refuse ZIP64 rather than truncate its offsets.
  if (
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    count === 0xffff ||
    archive.readUInt16LE(end + 8) !== count ||
    central + archive.readUInt32LE(end + 12) !== end
  )
    invalid()
  const entries: ArchiveEntry[] = []
  let totalBytes = 0
  for (let index = 0; index < count; index++) {
    if (central + 46 > end || archive.readUInt32LE(central) !== 0x02014b50) invalid()
    const flags = archive.readUInt16LE(central + 8)
    const method = archive.readUInt16LE(central + 10)
    const compressedSize = archive.readUInt32LE(central + 20)
    const size = archive.readUInt32LE(central + 24)
    const nameLength = archive.readUInt16LE(central + 28)
    const next =
      central +
      46 +
      nameLength +
      archive.readUInt16LE(central + 30) +
      archive.readUInt16LE(central + 32)
    if (next > end) invalid()
    const name = archive.subarray(central + 46, central + 46 + nameLength).toString()
    safeName(name)
    const mode = archive.readUInt32LE(central + 38) >>> 16
    const type = mode & 0o170000
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      (type && type !== 0o100000 && type !== 0o040000) ||
      size > MAX_MEMBER_BYTES ||
      compressedSize > MAX_ARCHIVE_BYTES ||
      archive.readUInt16LE(central + 34) !== 0
    )
      invalid()
    const local = archive.readUInt32LE(central + 42)
    if (
      local + 30 > centralStart ||
      archive.readUInt32LE(local) !== 0x04034b50 ||
      archive.readUInt16LE(local + 6) !== flags ||
      archive.readUInt16LE(local + 8) !== method
    )
      invalid()
    const localNameLength = archive.readUInt16LE(local + 26)
    const data = local + 30 + localNameLength + archive.readUInt16LE(local + 28)
    if (
      archive.subarray(local + 30, local + 30 + localNameLength).toString() !== name ||
      data + compressedSize > centralStart
    )
      invalid()
    const directory = name.endsWith('/') || type === 0o040000
    totalBytes += size
    if (totalBytes > MAX_ARCHIVE_BYTES || (directory && size !== 0)) invalid()
    const compressed = archive.subarray(data, data + compressedSize)
    const bytes =
      method === 0
        ? compressed
        : await unzipDeflate(compressed, { maxOutputLength: MAX_MEMBER_BYTES })
    if (bytes.length !== size) invalid()
    entries.push({ name, directory, executable: (mode & 0o111) !== 0, bytes })
    central = next
  }
  if (!entries.length || central !== end) invalid()
  return entries
}
