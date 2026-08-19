import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AttachmentRef, AttachmentStager } from '@podium/agent-runtime'
import { stateDir } from '@podium/runtime/config'
import { uploadFilePath } from '../upload.js'

/**
 * One machine-local byte landing for every runtime family. Files share the
 * existing uploads tree, so its lifecycle and garbage collector stay singular.
 */
export async function writeRuntimeAttachment(
  root: string,
  { sessionId, source }: Parameters<AttachmentStager>[0],
): Promise<AttachmentRef> {
  const id = randomUUID()
  const path = uploadFilePath(root, sessionId, id, source.mediaType, source.filename)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, source.bytes, { mode: 0o600 })

  const filename = source.filename.split(/[/\\]/).filter(Boolean).pop() ?? 'attachment'
  const ref: AttachmentRef = {
    id,
    path,
    filename,
    mediaType: source.mediaType,
    kind: source.mediaType.startsWith('image/') ? 'image' : 'file',
  }
  return ref
}

export const stageRuntimeAttachment: AttachmentStager = (input) =>
  writeRuntimeAttachment(stateDir(), input)
