import type { ControlMessage } from '@podium/protocol'
import { approvalHandlers } from './approvals'
import type { ControlHandlers, DaemonContext } from './context'
import { credentialHandlers } from './credentials'
import { discoveryHandlers } from './discovery'
import { execHandlers } from './exec'
import { fileHandlers } from './files'
import { handoffHandlers } from './handoff'
import { headlessHandlers } from './headless'
import { inventoryHandlers } from './inventory'
import { sessionHandlers } from './session'
import { transcriptHandlers } from './transcripts'
import { workspaceHandlers } from './workspace'

/**
 * THE control-frame registry (#195): one handler per frame type, grouped into
 * family modules, each receiving the explicit DaemonContext instead of closing
 * over startDaemon's scope. Mirrors the harness adapter registry contract
 * (packages/agent-bridge/src/harness/registry.ts): the mapped type over
 * `ControlMessage['type']` makes a new control frame a compile error here until
 * it declares a handler.
 */
export const CONTROL_HANDLERS: ControlHandlers = {
  ...sessionHandlers,
  ...discoveryHandlers,
  ...transcriptHandlers,
  ...fileHandlers,
  ...execHandlers,
  ...headlessHandlers,
  ...handoffHandlers,
  ...workspaceHandlers,
  ...approvalHandlers,
  ...credentialHandlers,
  ...inventoryHandlers,
  agentRelayResult: (ctx, msg) => ctx.agentRelayHub.onResult(msg),
}

/** Dispatch one parsed control frame to its family handler. */
export function dispatchControlMessage(ctx: DaemonContext, msg: ControlMessage): void {
  const handler = CONTROL_HANDLERS[msg.type] as (ctx: DaemonContext, msg: ControlMessage) => void
  handler(ctx, msg)
}
