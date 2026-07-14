import type { ControlMessage } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'
import {
  appendImportChunk,
  exportHandoffPackage,
  importHandoffPackage,
  readExportChunk,
} from '../handoff-package'

async function exportPackage(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffExportRequest' }>,
): Promise<void> {
  try {
    if (msg.agentKind !== 'claude-code' && msg.agentKind !== 'codex')
      throw new Error('unsupported handoff harness')
    const result = await exportHandoffPackage({
      ...msg,
      agentKind: msg.agentKind,
      homeDir: ctx.homeDir,
    })
    ctx.send({ type: 'handoffExportResult', requestId: msg.requestId, ok: true, ...result })
  } catch (error) {
    ctx.send({
      type: 'handoffExportResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

async function readChunk(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffChunkReadRequest' }>,
): Promise<void> {
  try {
    const result = await readExportChunk({ ...msg, homeDir: ctx.homeDir })
    ctx.send({
      type: 'handoffChunkReadResult',
      requestId: msg.requestId,
      ok: true,
      data: result.data.toString('base64'),
      sizeBytes: result.sizeBytes,
      eof: result.eof,
    })
  } catch (error) {
    ctx.send({
      type: 'handoffChunkReadResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

async function writeChunk(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffImportChunk' }>,
): Promise<void> {
  try {
    const sizeBytes = await appendImportChunk({
      homeDir: ctx.homeDir,
      sessionId: msg.sessionId,
      offset: msg.offset,
      data: Buffer.from(msg.data, 'base64'),
    })
    ctx.send({ type: 'handoffImportChunkResult', requestId: msg.requestId, ok: true, sizeBytes })
  } catch (error) {
    ctx.send({
      type: 'handoffImportChunkResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

async function importPackage(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffImportRequest' }>,
): Promise<void> {
  try {
    const result = await importHandoffPackage({ ...msg, homeDir: ctx.homeDir })
    ctx.send({
      type: 'handoffImportResult',
      requestId: msg.requestId,
      ok: true,
      newCwd: result.newCwd,
    })
  } catch (error) {
    ctx.send({
      type: 'handoffImportResult',
      requestId: msg.requestId,
      ok: false,
      error: String(error),
    })
  }
}

export const handoffHandlers: Pick<
  ControlHandlers,
  'handoffExportRequest' | 'handoffChunkReadRequest' | 'handoffImportChunk' | 'handoffImportRequest'
> = {
  handoffExportRequest: (ctx, msg) => {
    void exportPackage(ctx, msg)
  },
  handoffChunkReadRequest: (ctx, msg) => {
    void readChunk(ctx, msg)
  },
  handoffImportChunk: (ctx, msg) => {
    void writeChunk(ctx, msg)
  },
  handoffImportRequest: (ctx, msg) => {
    void importPackage(ctx, msg)
  },
}
