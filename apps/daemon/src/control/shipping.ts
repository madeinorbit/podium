import type { ControlMessage } from '@podium/protocol/daemon'
import type { ControlHandlers } from './context'

export const shippingHandlers: Pick<
  ControlHandlers,
  'shippingJobRequest' | 'shippingEvidenceRequest' | 'shippingRepairApplyRequest'
> = {
  shippingJobRequest: (ctx, msg: Extract<ControlMessage, { type: 'shippingJobRequest' }>) => {
    const result = ctx.shipping.handle(msg)
    ctx.send({ type: 'shippingJobResult', requestId: msg.requestId, ...result })
  },
  shippingEvidenceRequest: (
    ctx,
    msg: Extract<ControlMessage, { type: 'shippingEvidenceRequest' }>,
  ) => {
    const content = ctx.shipping.readEvidence(msg.authority, msg.artifactRef, msg.maxBytes)
    ctx.send({
      type: 'shippingEvidenceResult',
      requestId: msg.requestId,
      artifactRef: msg.artifactRef,
      ok: content !== null,
      ...(content !== null
        ? { content }
        : { error: 'shipping evidence authority did not match a retained artifact' }),
    })
  },
  shippingRepairApplyRequest: (
    ctx,
    msg: Extract<ControlMessage, { type: 'shippingRepairApplyRequest' }>,
  ) => {
    const result = ctx.shipping.applyPatch(msg)
    ctx.send({
      type: 'shippingRepairApplyResult',
      requestId: msg.requestId,
      ...result,
    })
  },
}
