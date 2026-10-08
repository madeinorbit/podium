import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { DeliveryReceipt, ShipOrderId } from '@podium/model'
import { formatAppError } from '@/app/AppErrorPage'
import type { ShippingPanelCommands } from './ShippingPanel'

/** Immutable proof, retained only while this shipment's details are open. */
export class ReceiptView extends RequestAnswer<DeliveryReceipt | null> {
  constructor(readonly orderId: ShipOrderId, private readonly commands: ShippingPanelCommands) {
    super((cause) => formatAppError(cause, 'Could not load receipt'))
  }
  refresh = (): Promise<void> => this.load(() => this.commands.getReceipt({ orderId: this.orderId }), true)
}
