import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ApprovalOp, ControlMessage } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'

const execFileAsync = promisify(execFile)

/**
 * Approval broker executor [spec:SP-edbb] (#410): run an operator-APPROVED
 * management op by spawning the podium binary. The op catalog is closed
 * (ApprovalOp) and each op maps to a FIXED argv — nothing agent-controlled
 * reaches the command line except the validated, UI-displayed op params.
 */

/** Closed op → argv map. */
export function approvalArgv(op: ApprovalOp): string[] {
  switch (op.kind) {
    case 'update':
      return ['update']
    case 'channel':
      return ['channel', op.target]
    case 'stop':
      return ['stop']
    case 'set-server':
      return ['set-server', op.target]
    case 'workflow-publish':
    case 'workflow-set-default':
    case 'automation-schedule':
      throw new Error(`${op.kind} is a server-owned approval operation`)
  }
}

/** The binary to spawn: an installed daemon IS the podium binary; a source/dev
 *  daemon (bun) falls back to `podium` on PATH. */
export function podiumBin(): string {
  const installed = !!process.env.PODIUM_HOME || /(?:^|[\\/])podium$/.test(process.execPath)
  return installed ? process.execPath : 'podium'
}

async function runApprovalExec(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'approvalExecRequest' }>,
): Promise<void> {
  const argv = approvalArgv(msg.op)
  try {
    // `podium update` exit codes are load-bearing: 10 = updated, 0 = already
    // current, else failure. execFile throws on non-zero, so both arms report.
    const { stdout, stderr } = await execFileAsync(podiumBin(), argv, {
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    })
    ctx.send({
      type: 'approvalExecResult',
      requestId: msg.requestId,
      ok: true,
      exitCode: 0,
      output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(),
    })
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    const exitCode = typeof e.code === 'number' ? e.code : null
    const ok = msg.op.kind === 'update' && exitCode === 10 // updated → restart follows
    ctx.send({
      type: 'approvalExecResult',
      requestId: msg.requestId,
      ok,
      exitCode,
      output:
        `${e.stdout ?? ''}${e.stderr ? `\n${e.stderr}` : ''}`.trim() || (e.message ?? String(err)),
    })
  }
}

export const approvalHandlers: Pick<ControlHandlers, 'approvalExecRequest'> = {
  approvalExecRequest: (ctx, msg) => void runApprovalExec(ctx, msg),
}
