import { sep } from 'node:path'
import type { ControlMessage } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'
import {
  appendImportChunk,
  exportHandoffPackage,
  importHandoffPackage,
  readExportChunk,
} from '../handoff-package'

/**
 * The cwd to export FROM: the agent's real working directory when we know it, else
 * the root the server holds.
 *
 * The server's `cwd` is a session's GROUPING key, which POD-665 pins to the worktree
 * root — so by the time a handoff runs, the subdirectory the agent was actually
 * working in survives only here, in the daemon's own hook tracking (POD-741).
 * Recovering it is what lets the agent resume where it left off rather than at the
 * root [spec:SP-3f7a], and it is what points the Claude transcript lookup at the
 * bucket the agent actually ran in — Claude buckets by launch cwd.
 *
 * CONTAINMENT IS THE GUARD, and it is load-bearing: a raw cwd is trusted only INSIDE
 * the root the server named. An agent that wandered into another checkout must never
 * drag the export there — that is exactly what the pin exists to prevent, and honouring
 * it here keeps "never hand off a main checkout" airtight [spec:SP-3f7a].
 */
function exportCwd(ctx: DaemonContext, sessionId: string, root: string): string {
  const raw = ctx.sessionCwdTracker.rawCwd(sessionId)
  if (!raw) return root
  return raw === root || raw.startsWith(`${root}${sep}`) ? raw : root
}

async function exportPackage(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffExportRequest' }>,
): Promise<void> {
  try {
    if (msg.agentKind !== 'claude-code' && msg.agentKind !== 'codex')
      throw new Error('unsupported handoff harness')
    const result = await exportHandoffPackage({
      ...msg,
      cwd: exportCwd(ctx, msg.sessionId, msg.cwd),
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
