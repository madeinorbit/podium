import type { ControlMessage } from '@podium/protocol'
import type { ControlHandlers } from './context'

export const shippingHandlers: Pick<ControlHandlers, 'shippingJobRequest'> = {
  shippingJobRequest: (ctx, msg: Extract<ControlMessage, { type: 'shippingJobRequest' }>) => {
    const result = ctx.shipping.handle(msg)
    ctx.send({ type: 'shippingJobResult', requestId: msg.requestId, ...result })
  },
}
