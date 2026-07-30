import type { ControlMessage } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'
import {
  cleanWorkspacePeeks,
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
} from '../workspace-package'

async function exportSnapshot(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'workspaceExportRequest' }>,
): Promise<void> {
  try {
    const result = await exportWorkspaceSnapshot({ ...msg, homeDir: ctx.homeDir })
    ctx.send({ type: 'workspaceExportResult', requestId: msg.requestId, ok: true, ...result })
  } catch (error) {
    ctx.send({
      type: 'workspaceExportResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

async function importSnapshot(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'workspaceImportRequest' }>,
): Promise<void> {
  try {
    const result = await importWorkspaceSnapshot({ ...msg, homeDir: ctx.homeDir })
    ctx.send({
      type: 'workspaceImportResult',
      requestId: msg.requestId,
      ok: true,
      path: result.path,
    })
  } catch (error) {
    ctx.send({
      type: 'workspaceImportResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

async function cleanPeeks(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'workspaceCleanRequest' }>,
): Promise<void> {
  try {
    const removed = await cleanWorkspacePeeks(msg.repoPath)
    ctx.send({ type: 'workspaceCleanResult', requestId: msg.requestId, ok: true, removed })
  } catch (error) {
    ctx.send({
      type: 'workspaceCleanResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

export const workspaceHandlers: Pick<
  ControlHandlers,
  'workspaceExportRequest' | 'workspaceImportRequest' | 'workspaceCleanRequest'
> = {
  workspaceExportRequest: (ctx, msg) => {
    void exportSnapshot(ctx, msg)
  },
  workspaceImportRequest: (ctx, msg) => {
    void importSnapshot(ctx, msg)
  },
  workspaceCleanRequest: (ctx, msg) => {
    void cleanPeeks(ctx, msg)
  },
}
