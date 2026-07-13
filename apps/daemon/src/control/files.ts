import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { ControlMessage } from '@podium/protocol'
import {
  listDirSandboxed,
  readAssetSandboxed,
  readFileSandboxed,
  writeFileSandboxed,
} from '../file-access'
import { uploadFilePath } from '../upload'
import type { ControlHandlers, DaemonContext } from './context'

async function handleImageUpload(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'imageUploadRequest' }>,
): Promise<void> {
  // Session ownership is intentionally NOT validated here: a client may upload
  // an image before the agent PTY is live (e.g. pre-spawn or during reconnect).
  // Async fs: decoding+writing a multi-MB base64 image synchronously blocked the
  // whole daemon loop for the duration of the write (audit P0-4).
  try {
    const id = randomUUID()
    const filePath = uploadFilePath(homedir(), msg.sessionId, id, msg.mimeType)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from(msg.dataBase64, 'base64'))
    ctx.send({ type: 'imageUploadResult', requestId: msg.requestId, path: filePath })
  } catch (err) {
    // Return an empty path + error so the router can throw INTERNAL_SERVER_ERROR
    // (a write failure, not a timeout).
    console.warn('[podium] image upload failed:', err)
    ctx.send({
      type: 'imageUploadResult',
      requestId: msg.requestId,
      path: '',
      error: String(err),
    })
  }
}

/** Sandboxed file access + image uploads. The read/write/list handlers all share
 *  the must-answer posture: a reject (ENOENT race, EACCES, decode failure) would
 *  otherwise be an unhandled rejection AND leave the server's pending resolver
 *  hanging until its 10s timeout (audit P0-1) — reply with an error result. */
export const fileHandlers: Pick<
  ControlHandlers,
  | 'fileReadRequest'
  | 'fileAssetRequest'
  | 'fileWriteRequest'
  | 'dirListRequest'
  | 'imageUploadRequest'
> = {
  imageUploadRequest: (ctx, msg) => {
    void handleImageUpload(ctx, msg)
  },
  fileReadRequest: (ctx, msg) => {
    void readFileSandboxed({ cwd: msg.cwd, path: msg.path, knownPath: msg.knownPath })
      .then((r) => ctx.send({ type: 'fileReadResult', requestId: msg.requestId, ...r }))
      .catch((err) =>
        ctx.send({
          type: 'fileReadResult',
          requestId: msg.requestId,
          ok: false,
          path: msg.path,
          error: String(err),
        }),
      )
  },
  fileAssetRequest: (ctx, msg) => {
    void readAssetSandboxed({
      cwd: msg.cwd,
      path: msg.path,
      knownPath: msg.knownPath,
      ...(msg.offset !== undefined ? { offset: msg.offset } : {}),
      ...(msg.length !== undefined ? { length: msg.length } : {}),
    })
      .then((r) => ctx.send({ type: 'fileAssetResult', requestId: msg.requestId, ...r }))
      .catch((err) =>
        ctx.send({
          type: 'fileAssetResult',
          requestId: msg.requestId,
          ok: false,
          path: msg.path,
          error: String(err),
        }),
      )
  },
  fileWriteRequest: (ctx, msg) => {
    void writeFileSandboxed({
      cwd: msg.cwd,
      path: msg.path,
      content: msg.content,
      ...(msg.baseHash ? { baseHash: msg.baseHash } : {}),
    })
      .then((r) => ctx.send({ type: 'fileWriteResult', requestId: msg.requestId, ...r }))
      .catch((err) =>
        ctx.send({
          type: 'fileWriteResult',
          requestId: msg.requestId,
          ok: false,
          error: String(err),
        }),
      )
  },
  dirListRequest: (ctx, msg) => {
    void listDirSandboxed({ root: msg.root, path: msg.path })
      .then((r) => ctx.send({ type: 'dirListResult', requestId: msg.requestId, ...r }))
      .catch((err) =>
        ctx.send({
          type: 'dirListResult',
          requestId: msg.requestId,
          ok: false,
          path: msg.path,
          entries: [],
          error: String(err),
        }),
      )
  },
}
