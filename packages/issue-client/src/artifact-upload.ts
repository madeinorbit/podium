import { randomUUID } from 'node:crypto'
import { ARTIFACT_UPLOAD_CHUNK_BYTES, type ArtifactUploadPacket } from '@podium/model'
import type { IssueTrpc } from './client.js'

export interface ArtifactSource {
  path: string
  entry: string
  files: Array<{ path: string; size: number; chunks(): AsyncIterable<Uint8Array> }>
}

export interface IssueCommandEnvironment {
  /** Only the CLI supplies local file access. In-process MCP must never read
   * arbitrary paths on the server on behalf of its caller. */
  readArtifactSource?(path: string, name?: string): Promise<ArtifactSource>
}

export function artifactFromText(name: string, content: string): ArtifactSource {
  const bytes = Buffer.from(content)
  return {
    path: name,
    entry: name,
    files: [
      {
        path: name,
        size: bytes.length,
        async *chunks() {
          for (let offset = 0; offset < bytes.length; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) {
            yield bytes.subarray(offset, offset + ARTIFACT_UPLOAD_CHUNK_BYTES)
          }
        },
      },
    ],
  }
}

export async function uploadArtifact(
  client: IssueTrpc,
  id: string,
  source: ArtifactSource,
  title?: string,
): Promise<unknown> {
  const uploadId = randomUUID()
  const send = async (upload: ArtifactUploadPacket) =>
    await client.issues.panelApply.mutate({ id, op: 'artifact-upload', upload })
  await send({
    action: 'begin',
    uploadId,
    path: source.path,
    entry: source.entry,
    files: source.files.map(({ path, size }) => ({ path, size })),
    ...(title !== undefined ? { title } : {}),
  })
  try {
    for (const file of source.files) {
      let offset = 0
      for await (const chunk of file.chunks()) {
        for (let start = 0; start < chunk.length; start += ARTIFACT_UPLOAD_CHUNK_BYTES) {
          const bytes = chunk.subarray(start, start + ARTIFACT_UPLOAD_CHUNK_BYTES)
          await send({
            action: 'chunk',
            uploadId,
            file: file.path,
            offset,
            dataBase64: Buffer.from(bytes).toString('base64'),
          })
          offset += bytes.length
        }
      }
      if (offset !== file.size)
        throw new Error(`artifact source changed while reading ${file.path}`)
    }
    return await send({ action: 'commit', uploadId })
  } catch (error) {
    await send({ action: 'abort', uploadId }).catch(() => {})
    throw error
  }
}
