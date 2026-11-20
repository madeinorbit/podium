import type { BuiltinHarnessKind } from '@podium/model'
import type { HarnessInstallAction } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from '../control/context'

async function run(
  ctx: DaemonContext,
  msg: { requestId: string; harness: BuiltinHarnessKind },
  action: HarnessInstallAction,
  type:
    | 'harnessInstallResult'
    | 'harnessCheckResult'
    | 'harnessBackResult'
    | 'harnessPauseResult'
    | 'harnessResumeResult'
    | 'harnessTakeSettingsResult'
    | 'harnessRemoveChangesResult'
    | 'harnessChangesResult'
    | 'harnessRemoveResult',
) {
  const result = ctx.harnessInstalls
    ? await ctx.harnessInstalls.run(action, msg.harness)
    : { ok: false, error: 'This machine cannot manage harness installs. Update its Podium daemon.' }
  ctx.send({ type, requestId: msg.requestId, ...result })
}

export const installHandlers: Pick<
  ControlHandlers,
  | 'harnessInstallRequest'
  | 'harnessCheckRequest'
  | 'harnessBackRequest'
  | 'harnessPauseRequest'
  | 'harnessResumeRequest'
  | 'harnessTakeSettingsRequest'
  | 'harnessRemoveChangesRequest'
  | 'harnessChangesRequest'
  | 'harnessRemoveRequest'
> = {
  harnessInstallRequest: (ctx, msg) => {
    void run(ctx, msg, 'install', 'harnessInstallResult')
  },
  harnessCheckRequest: (ctx, msg) => {
    void run(ctx, msg, 'check', 'harnessCheckResult')
  },
  harnessBackRequest: (ctx, msg) => {
    void run(ctx, msg, 'back', 'harnessBackResult')
  },
  harnessPauseRequest: (ctx, msg) => {
    void run(ctx, msg, 'pause', 'harnessPauseResult')
  },
  harnessResumeRequest: (ctx, msg) => {
    void run(ctx, msg, 'resume', 'harnessResumeResult')
  },
  harnessTakeSettingsRequest: (ctx, msg) => {
    void run(ctx, msg, 'take-settings', 'harnessTakeSettingsResult')
  },
  harnessRemoveChangesRequest: (ctx, msg) => {
    void run(ctx, msg, 'remove-changes', 'harnessRemoveChangesResult')
  },
  harnessChangesRequest: (ctx, msg) => {
    void run(ctx, msg, 'changes', 'harnessChangesResult')
  },
  harnessRemoveRequest: (ctx, msg) => {
    void run(ctx, msg, 'remove', 'harnessRemoveResult')
  },
}
