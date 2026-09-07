import { asMachineId } from '@podium/model'
import type { ControlHandlers, DaemonContext } from './context'

async function probe(
  ctx: DaemonContext,
  msg: Parameters<ControlHandlers['serverEndpointProbeRequest']>[1],
): Promise<void> {
  try {
    await ctx.probeServerTransferCandidate({
      ...msg,
      targetMachineId: asMachineId(msg.targetMachineId),
    })
    ctx.send({
      type: 'serverEndpointResult',
      requestId: msg.requestId,
      transferId: msg.transferId,
      operation: 'probe',
      ok: true,
      publicUrl: msg.publicUrl,
    })
    // The acknowledgement is already on the old authenticated socket. Everything
    // produced after it is held until either abort resumes this authority or commit
    // authenticates and switches to the promoted authority.
    ctx.quiesceServerEndpoint(msg.transferId)
  } catch (error) {
    ctx.send({
      type: 'serverEndpointResult',
      requestId: msg.requestId,
      transferId: msg.transferId,
      operation: 'probe',
      ok: false,
      publicUrl: msg.publicUrl,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function commit(
  ctx: DaemonContext,
  msg: Parameters<ControlHandlers['serverEndpointCommitRequest']>[1],
): Promise<void> {
  try {
    await ctx.prepareServerEndpointCommit(msg.transferId, msg.publicUrl)
    ctx.send({
      type: 'serverEndpointResult',
      requestId: msg.requestId,
      transferId: msg.transferId,
      operation: 'commit',
      ok: true,
      publicUrl: msg.publicUrl,
    })
    setTimeout(() => ctx.activateServerEndpoint(msg.transferId), 0)
  } catch (error) {
    ctx.send({
      type: 'serverEndpointResult',
      requestId: msg.requestId,
      transferId: msg.transferId,
      operation: 'commit',
      ok: false,
      publicUrl: msg.publicUrl,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function resume(
  ctx: DaemonContext,
  msg: Parameters<ControlHandlers['serverEndpointResumeRequest']>[1],
): void {
  ctx.send({
    type: 'serverEndpointResult',
    requestId: msg.requestId,
    transferId: msg.transferId,
    operation: 'resume',
    ok: true,
  })
  ctx.resumeServerEndpoint(msg.transferId)
}

export const serverEndpointHandlers: Pick<
  ControlHandlers,
  'serverEndpointProbeRequest' | 'serverEndpointCommitRequest' | 'serverEndpointResumeRequest'
> = {
  serverEndpointProbeRequest: (ctx, msg) => void probe(ctx, msg),
  serverEndpointCommitRequest: (ctx, msg) => void commit(ctx, msg),
  serverEndpointResumeRequest: resume,
}
