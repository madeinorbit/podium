import type { ControlMessage } from '@podium/protocol/daemon'
import { handleCredentialExport, handleCredentialInstall } from '@podium/harness/inventory'
import { createLogger } from '@podium/logger'
import { runtimeHandlers } from '../runtime/handlers'
import { serverTransferHandlers } from '../server-transfer'
import { approvalHandlers } from './approvals'
import type { ControlHandlers, DaemonContext } from './context'
import { discoveryHandlers } from './discovery'
import { execHandlers } from './exec'
import { fileHandlers } from './files'
import { handoffHandlers } from './handoff'
import { inventoryHandlers, reportInventory } from './inventory'
import { serverEndpointHandlers } from './server-endpoint'
import { logHandlers } from './logs'
import { sessionHandlers } from './session'
import { shippingHandlers } from './shipping'
import { transcriptHandlers } from './transcripts'
import { updateHandlers } from './update'
import { workspaceHandlers } from './workspace'

const log = createLogger('daemon:control')

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

/**
 * THE LEGACY HEADLESS FRAMES (POD-4614). Headless turns run through the
 * driver-contract relay (`RuntimeDriver 'headless'`, under podium-host); the
 * legacy port that served `headlessTurnRequest`/`headlessInterrupt`/
 * `headlessBind` is deleted. A server old enough to still send them gets a
 * loud refusal on the frame it waits for, never silence. `headlessTurnAck`
 * is live: the relay has no ack verb yet, so the server still releases a
 * turn's host through it.
 */
const LEGACY_HEADLESS_REFUSAL =
  'the legacy headless port is retired (POD-4614): dispatch headless turns through the runtime relay'

const legacyHeadlessHandlers: Pick<
  ControlHandlers,
  'headlessTurnRequest' | 'headlessInterrupt' | 'headlessTurnAck' | 'headlessBind'
> = {
  headlessTurnRequest: (ctx, msg) => {
    ctx.send({
      type: 'headlessTurnResult',
      requestId: msg.requestId,
      ok: false,
      error: LEGACY_HEADLESS_REFUSAL,
      accountId: msg.accountId,
      requestDigest: msg.requestDigest,
    })
  },
  headlessInterrupt: (_ctx, msg) => {
    log.warn('legacy headlessInterrupt refused', { sessionId: msg.sessionId })
  },
  headlessTurnAck: (ctx, msg) => {
    const runtime = ctx.agentRuntime
    if (!runtime) return
    void runtime
      .acknowledgeHeadlessTurn({
        sessionId: msg.sessionId,
        turnId: msg.turnId,
        accountId: msg.accountId,
        requestDigest: msg.requestDigest,
      })
      .catch((err: unknown) =>
        log.warn('headless turn acknowledgement refused', { err, turnId: msg.turnId }),
      )
  },
  headlessBind: (ctx, msg) => {
    ctx.send({
      type: 'headlessBindResult',
      requestId: msg.requestId,
      ok: false,
      error: LEGACY_HEADLESS_REFUSAL,
    })
  },
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
  ...legacyHeadlessHandlers,
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
