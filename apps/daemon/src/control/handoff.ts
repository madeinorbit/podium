import { sep } from 'node:path'
import { asMachineId, type SessionId } from '@podium/model'
import type { ControlMessage, HandoffBindingTransfer } from '@podium/protocol'
import type { SessionBindingTransitionOutcome } from '../binding-store'
import {
  appendImportChunk,
  exportHandoffPackage,
  importHandoffPackage,
  readExportChunk,
} from '../handoff-package'
import type { ControlHandlers, DaemonContext } from './context'

type AppliedBindingOutcome = Extract<
  SessionBindingTransitionOutcome,
  { status: 'applied' | 'unchanged' }
>

function bindingApplied(
  outcome: SessionBindingTransitionOutcome,
): outcome is AppliedBindingOutcome {
  return outcome.status === 'applied' || outcome.status === 'unchanged'
}

function bindingRefusal(
  outcome: SessionBindingTransitionOutcome,
): { error: string; refusal?: 'unauthorized' | 'unreachable' } | null {
  if (outcome.status === 'applied' || outcome.status === 'unchanged') return null
  if (outcome.status === 'denied') return { error: 'handoff refused', refusal: 'unauthorized' }
  if (outcome.status === 'unreachable') {
    return { error: 'handoff target unreachable', refusal: 'unreachable' }
  }
  // Uniform host answer: a missing/inaccessible binding and any other rejected
  // claim reveal no different session-existence fact.
  return { error: 'handoff refused' }
}

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
function exportCwd(ctx: DaemonContext, sessionId: SessionId, root: string): string {
  const raw = ctx.sessionCwdTracker.rawCwd(sessionId)
  if (!raw) return root
  return raw === root || raw.startsWith(`${root}${sep}`) ? raw : root
}

async function exportPackage(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffExportRequest' }>,
): Promise<void> {
  let claimed = false
  try {
    if (msg.agentKind !== 'claude-code' && msg.agentKind !== 'codex')
      throw new Error('unsupported handoff harness')
    if (!msg.binding) {
      ctx.send({
        type: 'handoffExportResult',
        requestId: msg.requestId,
        ok: false,
        error: 'handoff refused',
      })
      return
    }
    const fromMachineId = asMachineId(msg.sourceMachineId)
    const toMachineId = asMachineId(msg.binding.targetMachineId)
    if (fromMachineId !== ctx.machineId) throw new Error('handoff refused')
    const claim = await ctx.sessionBinding.transition({
      event: 'adopt',
      transitionId: msg.binding.transitionId,
      sessionId: msg.sessionId,
      machineAccess: msg.binding.machineAccess,
      transferId: msg.binding.transferId,
      role: 'source',
      phase: 'claim',
      fromMachineId,
      toMachineId,
      at: new Date().toISOString(),
    })
    const refused = bindingRefusal(claim)
    if (refused) {
      ctx.send({ type: 'handoffExportResult', requestId: msg.requestId, ok: false, ...refused })
      return
    }
    if (!bindingApplied(claim)) return
    claimed = true
    const delegation = ctx.sessionBinding.delegation(claim.binding)
    if (!delegation || claim.binding.agentKind !== msg.agentKind) throw new Error('handoff refused')
    const result = await exportHandoffPackage({
      ...msg,
      cwd: exportCwd(ctx, msg.sessionId, msg.cwd),
      agentKind: msg.agentKind,
      exportedBy: msg.binding.exportedBy,
      owner: msg.binding.owner,
      visibility: msg.binding.visibility,
      homeDir: ctx.homeDir,
    })
    const binding: HandoffBindingTransfer = {
      transferId: msg.binding.transferId,
      sessionId: msg.sessionId,
      agentKind: claim.binding.agentKind,
      fromMachineId,
      toMachineId,
      observationGeneration: claim.binding.observationGeneration + 1,
      delegation: {
        actor: delegation.actor,
        onBehalfOf: delegation.onBehalfOf,
        grantedScope: delegation.grantedScope,
        parentBindingId: delegation.parentBindingId,
      },
    }
    ctx.send({
      type: 'handoffExportResult',
      requestId: msg.requestId,
      ok: true,
      ...result,
      binding,
    })
  } catch (error) {
    if (claimed && msg.binding) {
      await ctx.sessionBinding.transition({
        event: 'adopt',
        transitionId: `${msg.binding.transitionId}:export-abort`,
        sessionId: msg.sessionId,
        machineAccess: 'allowed',
        transferId: msg.binding.transferId,
        role: 'source',
        phase: 'abort',
        fromMachineId: asMachineId(msg.sourceMachineId),
        toMachineId: asMachineId(msg.binding.targetMachineId),
        at: new Date().toISOString(),
      })
    }
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
    if (!msg.binding || msg.binding.transfer.sessionId !== msg.sessionId) {
      ctx.send({
        type: 'handoffImportResult',
        requestId: msg.requestId,
        ok: false,
        error: 'handoff refused',
      })
      return
    }
    const transfer = msg.binding.transfer
    if (transfer.toMachineId !== ctx.machineId) throw new Error('handoff refused')
    // Refuse before untarring, fetching, or hard-syncing a worktree. The host
    // consumes the fleet ACL answer supplied by its owning server interface; it
    // does not reconstruct fleet policy locally.
    if (msg.binding.machineAccess !== 'allowed') {
      const refusal =
        msg.binding.machineAccess === 'denied'
          ? { error: 'handoff refused', refusal: 'unauthorized' as const }
          : { error: 'handoff target unreachable', refusal: 'unreachable' as const }
      ctx.send({ type: 'handoffImportResult', requestId: msg.requestId, ok: false, ...refusal })
      return
    }
    const result = await importHandoffPackage({ ...msg, homeDir: ctx.homeDir })
    if (
      result.manifest.sessionId !== transfer.sessionId ||
      result.manifest.agentKind !== transfer.agentKind
    ) {
      throw new Error('handoff refused')
    }
    const claim = await ctx.sessionBinding.transition({
      event: 'adopt',
      transitionId: msg.binding.transitionId,
      sessionId: msg.sessionId,
      machineAccess: msg.binding.machineAccess,
      transferId: transfer.transferId,
      role: 'target',
      phase: 'claim',
      fromMachineId: asMachineId(transfer.fromMachineId),
      toMachineId: asMachineId(transfer.toMachineId),
      at: new Date().toISOString(),
      adoption: {
        agentKind: transfer.agentKind,
        observationGeneration: transfer.observationGeneration,
        delegation: transfer.delegation,
        observations: [
          {
            channel: 'resume-ref',
            value: result.manifest.resume.value,
            nativeKind: result.manifest.resume.kind,
          },
          {
            channel: result.manifest.agentKind === 'codex' ? 'rollout-path' : 'transcript-path',
            value: result.nativeArtifactPath,
          },
          { channel: 'cwd', value: result.newCwd },
          { channel: 'worktree-pin', value: result.worktreeRoot },
        ],
      },
    })
    const refused = bindingRefusal(claim)
    if (refused) {
      ctx.send({ type: 'handoffImportResult', requestId: msg.requestId, ok: false, ...refused })
      return
    }
    if (!bindingApplied(claim)) return
    ctx.send({
      type: 'handoffImportResult',
      requestId: msg.requestId,
      ok: true,
      newCwd: result.newCwd,
      worktreeRoot: result.worktreeRoot,
      observationGeneration: claim.binding.observationGeneration,
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

async function finalizeBinding(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'handoffBindingFinalizeRequest' }>,
): Promise<void> {
  try {
    const outcome = await ctx.sessionBinding.transition({
      event: 'adopt',
      transitionId: msg.transitionId,
      sessionId: msg.sessionId,
      machineAccess: msg.machineAccess,
      transferId: msg.transferId,
      role: msg.role,
      phase: msg.phase,
      fromMachineId: asMachineId(msg.fromMachineId),
      toMachineId: asMachineId(msg.toMachineId),
      at: new Date().toISOString(),
    })
    const refused = bindingRefusal(outcome)
    if (refused) {
      ctx.send({
        type: 'handoffBindingFinalizeResult',
        requestId: msg.requestId,
        ok: false,
        ...refused,
      })
      return
    }
    if (!bindingApplied(outcome)) return
    ctx.send({
      type: 'handoffBindingFinalizeResult',
      requestId: msg.requestId,
      ok: true,
      observationGeneration: outcome.binding.observationGeneration,
    })
  } catch (error) {
    ctx.send({
      type: 'handoffBindingFinalizeResult',
      requestId: msg.requestId,
      ok: false,
      error: 'handoff refused',
    })
  }
}

export const handoffHandlers: Pick<
  ControlHandlers,
  | 'handoffExportRequest'
  | 'handoffChunkReadRequest'
  | 'handoffImportChunk'
  | 'handoffImportRequest'
  | 'handoffBindingFinalizeRequest'
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
  handoffBindingFinalizeRequest: (ctx, msg) => {
    void finalizeBinding(ctx, msg)
  },
}
