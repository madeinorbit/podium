import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, inflateRaw } from 'node:zlib'

const unzipGzip = promisify(gunzip)
const unzipDeflate = promisify(inflateRaw)
const MAX_MEMBER_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024

export type ReleaseArchiveFormat = 'tar.gz' | 'zip'

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
  if (archive.length > MAX_ARCHIVE_BYTES) invalid()
  return format === 'tar.gz'
    ? tarMember(await unzipGzip(archive, { maxOutputLength: MAX_ARCHIVE_BYTES }), member)
    : zipMember(archive, member)
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
    name.split('/').some((part) => part === '..' || part === '.')
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

function tarMember(archive: Buffer, member: string): Buffer {
  let binary: Buffer | undefined
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0)
    if (checksum !== octal(header.subarray(148, 156))) invalid()
    const prefix = text(header.subarray(345, 500))
    const name = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`
    safeName(name)
    const size = octal(header.subarray(124, 136))
    const type = header[156]
    const regular = type === 0 || type === 48
    if ((!regular && type !== 53) || !Number.isSafeInteger(size) || size > MAX_MEMBER_BYTES)
      invalid()
    const end = offset + 512 + size
    if (end > archive.length) invalid()
    if (name === member) {
      if (!regular || binary || size === 0) invalid()
      binary = archive.subarray(offset + 512, end)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!binary || archive.subarray(offset).some((byte) => byte !== 0)) invalid()
  return binary
}

/** Central directory sizes also cover ZIP members using data descriptors. */
async function zipMember(archive: Buffer, member: string): Promise<Buffer> {
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
  let binary: Buffer | undefined
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
    if (name === member) {
      if (binary || !size || name.endsWith('/') || type === 0o040000) invalid()
      const compressed = archive.subarray(data, data + compressedSize)
      binary =
        method === 0
          ? compressed
          : await unzipDeflate(compressed, { maxOutputLength: MAX_MEMBER_BYTES })
      if (binary.length !== size) invalid()
    }
    central = next
  }
  if (!binary || central !== end) invalid()
  return binary
}
