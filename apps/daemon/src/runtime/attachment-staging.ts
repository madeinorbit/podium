import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  type AttachmentRef,
  type AttachmentStager,
  attachmentKindFor,
} from '@podium/harness/driver/host'
import { stateDir } from '@podium/runtime/config'
import { uploadFilePath } from '../upload.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One machine-local byte landing for every runtime family. Files share the
 * existing uploads tree, so its lifecycle and garbage collector stay singular.
 */
export async function writeRuntimeAttachment(
  root: string,
  { sessionId, source }: Parameters<AttachmentStager>[0],
): Promise<AttachmentRef> {
  // A caller-chosen id names the file, so it must be a UUID and nothing else:
  // staging the same upload twice then overwrites one file (POD-2148).
  if (source.id !== undefined && !UUID.test(source.id))
    throw new Error('attachment id must be a UUID')
  const id = source.id ?? randomUUID()
  const path = uploadFilePath(root, sessionId, id, source.mediaType, source.filename)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Written beside it and renamed over it: staging the same upload again
  // replaces the file whole, never truncating one an earlier turn is reading.
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, source.bytes, { mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }

  const filename = source.filename.split(/[/\\]/).filter(Boolean).pop() ?? 'attachment'
  const ref: AttachmentRef = {
    id,
    path,
    filename,
    mediaType: source.mediaType,
    kind: attachmentKindFor(source.mediaType),
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
