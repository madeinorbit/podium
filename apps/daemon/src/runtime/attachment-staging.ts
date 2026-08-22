import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
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

/** The send-time authority check: the ref must resolve to a regular file directly
 * inside this session's real staging directory. Resolving both sides rejects
 * traversal, cross-session refs, nonexistent files, and symlink escapes. */
export function runtimeAttachmentBelongsToSession(
  root: string,
  sessionId: string,
  attachment: AttachmentRef,
): boolean {
  try {
    const stagedDir = realpathSync(join(root, 'uploads', sessionId))
    const actual = realpathSync(attachment.path)
    const fromStagedDir = relative(stagedDir, actual)
    return (
      fromStagedDir !== '' &&
      fromStagedDir !== '..' &&
      !fromStagedDir.startsWith(`..${sep}`) &&
      !isAbsolute(fromStagedDir) &&
      dirname(fromStagedDir) === '.' &&
      basename(actual).startsWith(`${attachment.id}.`) &&
      statSync(actual).isFile()
    )
  } catch {
    return false
  }
}

export const stageRuntimeAttachment: AttachmentStager = (input) =>
  writeRuntimeAttachment(stateDir(), input)
