import type { ControlMessage } from '@podium/protocol/daemon'
import { handleCredentialExport, handleCredentialInstall } from '@podium/harness/inventory'
import { runtimeHandlers } from '../runtime/handlers'
import { serverTransferHandlers } from '../server-transfer'
import { approvalHandlers } from './approvals'
import type { ControlHandlers, DaemonContext } from './context'
import { discoveryHandlers } from './discovery'
import { execHandlers } from './exec'
import { fileHandlers } from './files'
import { handoffHandlers } from './handoff'
import { headlessHandlers } from './headless'
import { inventoryHandlers, reportInventory } from './inventory'
import { serverEndpointHandlers } from './server-endpoint'
import { logHandlers } from './logs'
import { sessionHandlers } from './session'
import { shippingHandlers } from './shipping'
import { transcriptHandlers } from './transcripts'
import { updateHandlers } from './update'
import { workspaceHandlers } from './workspace'

/**
 * Credential export/install frames are served by the harness Inventory
 * mechanism (`@podium/harness/inventory`), which reads adapter credential
 * sections — the daemon only injects its ports (home, runtime snapshot for
 * the read environment, inventory re-probe after an install) and sends the
 * resulting frame. No harness is named here; kinds flow as values.
 */
function credentialPorts(ctx: DaemonContext) {
  return {
    ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
    snapshotRuntime: async () => {
      const snapshot = await ctx.harnessRuntime?.current().catch(() => undefined)
      if (!snapshot) return undefined
      return {
        env: snapshot.commandEnvironment.env,
        versions: new Map(
          [...snapshot.executables].map(
            ([kind, executable]) => [kind, executable.version] as const,
          ),
        ),
      }
    },
    reportInventory: () => reportInventory(ctx, { rebuild: true }),
  }
}

const credentialHandlers: Pick<
  ControlHandlers,
  'credentialExportRequest' | 'credentialInstallRequest'
> = {
  credentialExportRequest: (ctx, msg) => {
    void handleCredentialExport(credentialPorts(ctx), msg).then((result) => ctx.send(result))
  },
  credentialInstallRequest: (ctx, msg) => {
    void handleCredentialInstall(credentialPorts(ctx), msg).then((result) => ctx.send(result))
  },
}

/**
 * THE control-frame registry (#195): one handler per frame type, grouped into
 * family modules, each receiving the explicit DaemonContext instead of closing
 * over startDaemon's scope. Mirrors the harness adapter registry contract
 * (packages/harness/src/harness/registry.ts): the mapped type over
 * `ControlMessage['type']` makes a new control frame a compile error here until
 * it declares a handler.
 */
export const CONTROL_HANDLERS: ControlHandlers = {
  ...sessionHandlers,
  ...runtimeHandlers,
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
  ...logHandlers,
  ...updateHandlers,
  ...serverTransferHandlers,
  ...serverEndpointHandlers,
  ...shippingHandlers,
  agentRelayResult: (ctx, msg) => ctx.agentRelayHub.onResult(msg),
  updateGrant: (ctx, msg) => {
    void ctx.applyUpdateGrant(msg)
  },
}

/** Dispatch one parsed control frame to its family handler. */
export function dispatchControlMessage(ctx: DaemonContext, msg: ControlMessage): void {
  const handler = CONTROL_HANDLERS[msg.type] as (ctx: DaemonContext, msg: ControlMessage) => void
  handler(ctx, msg)
}
