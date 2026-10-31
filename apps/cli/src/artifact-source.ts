import { lstat, open, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ArtifactSource } from '@podium/issue-client'
import {
  ARTIFACT_BUNDLE_CAP_BYTES,
  ARTIFACT_FILE_CAP_BYTES,
  ARTIFACT_FILE_COUNT_CAP,
  ARTIFACT_UPLOAD_CHUNK_BYTES,
} from '@podium/model'

/** Local IO belongs to the CLI, never the shared in-process MCP command table. */
export async function readArtifactSource(
  source: string,
  name?: string,
  input: AsyncIterable<Uint8Array> = process.stdin,
): Promise<ArtifactSource> {
  if (source === '-') {
    if (!name) throw new Error('--add - requires --name <filename>')
    if (input === process.stdin && process.stdin.isTTY)
      throw new Error('pipe content into --add -, or use --content')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > ARTIFACT_FILE_CAP_BYTES)
        throw new Error('artifact stdin exceeds the 100MB per-file cap')
      chunks.push(bytes)
    }
    return {
      path: name,
      entry: name,
      files: [
        {
          path: name,
          size,
          async *chunks() {
            yield* chunks
          },
        },
      ],
    }
  }
  const root = resolve(source)
  const files: ArtifactSource['files'] = []
  let total = 0
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const info = await lstat(absolute)
    if (info.isSymbolicLink())
      throw new Error(`artifact bundles cannot contain symbolic links: ${absolute}`)
    if (info.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) {
        await walk(join(absolute, child), relative ? `${relative}/${child}` : child)
      }
      return
    }
    if (!info.isFile()) throw new Error(`artifact source is not a regular file: ${absolute}`)
    if (info.size > ARTIFACT_FILE_CAP_BYTES)
      throw new Error(`${absolute} exceeds the 100MB per-file cap`)
    total += info.size
    if (total > ARTIFACT_BUNDLE_CAP_BYTES) throw new Error('artifact bundle exceeds 500MB')
    if (files.length >= ARTIFACT_FILE_COUNT_CAP)
      throw new Error('artifact bundle exceeds 200 files')
    files.push({
      path: relative || basename(absolute),
      size: info.size,
      async *chunks() {
        const handle = await open(absolute, 'r')
        try {
          const before = await handle.stat()
          if (
            before.ino !== info.ino ||
            before.size !== info.size ||
            before.mtimeMs !== info.mtimeMs
          ) {
            throw new Error(`artifact source changed before upload: ${absolute}`)
          }
          for (let offset = 0; offset < info.size; ) {
            const buffer = Buffer.alloc(Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, info.size - offset))
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
            if (!bytesRead) throw new Error(`artifact source changed while reading: ${absolute}`)
            offset += bytesRead
            yield buffer.subarray(0, bytesRead)
          }
          const after = await handle.stat()
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
            throw new Error(`artifact source changed during upload: ${absolute}`)
          }
        } finally {
          await handle.close()
        }
      },
    })
  }
  await walk(root, '')
  const first = files[0]
  if (!first) throw new Error('artifact directory has no files')
  const entry =
    files.find((file) => file.path === 'index.html')?.path ??
    files.find((file) => /\.(html?|md)$/i.test(file.path))?.path ??
    first.path
  return { path: name ?? (isAbsolute(source) ? basename(root) : source), entry, files }
}
