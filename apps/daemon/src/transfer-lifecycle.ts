import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

async function waitForWorker(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('server promotion worker timed out'))
    }, 45_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`server promotion worker exited ${code ?? signal ?? 'unknown'}`))
    })
  })
}

export interface TargetLifecycleDeps {
  spawnProcess?: typeof spawn
}

export interface TargetRetirementDeps extends TargetLifecycleDeps {
  /** Injected by tests; production uses a short response-flush delay. */
  schedule?: (callback: () => void, delayMs: number) => void
  flushDelayMs?: number
}

function lifecycleInvocation(
  subcommand: string,
  args: string[] = [],
): { cmd: string; args: string[] } {
  if (import.meta.url.includes('/$bunfs/')) {
    return { cmd: process.execPath, args: [subcommand, ...args] }
  }
  const cliPath = fileURLToPath(new URL('../../../scripts/cli.ts', import.meta.url))
  return {
    cmd: process.execPath,
    args: ['--conditions=@podium/source', cliPath, subcommand, ...args],
  }
}

/**
 * Start and prove the new server role without relinquishing the target daemon process. The caller
 * still needs this daemon to send the promotion result and to answer an idempotent retry if that
 * result is lost.
 */
export async function restartAsServer(
  input: { transferId: string },
  deps: TargetLifecycleDeps = {},
): Promise<void> {
  const spawnProcess = deps.spawnProcess ?? spawn
  const promote = lifecycleInvocation('server-transfer-promote', [input.transferId])
  const child = spawnProcess(promote.cmd, promote.args, {
    stdio: 'ignore',
    env: { ...process.env },
  })
  await waitForWorker(child)
  // Deliberately retain this daemon after local serving proof. A timer cannot prove that the
  // promote reply reached the source; retaining the control channel makes a lost reply retryable.
  // Promotion disarms managed resurrection, and an explicit post-ack seam retires this process.
}

/**
 * Context callback for the promoted-proof acknowledgement handler. Only that explicit ack may
 * schedule daemon retirement. The short delay is not a delivery guess: acknowledgement already
 * happened, and the delay exists solely to let its response bytes leave this process before the
 * detached retirement worker stops it.
 */
export function retireTargetDaemonAfterAcknowledgement(deps: TargetRetirementDeps = {}): void {
  const spawnProcess = deps.spawnProcess ?? spawn
  const schedule = deps.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs))
  schedule(() => {
    const retire = lifecycleInvocation('server-transfer-retire-daemon')
    const worker = spawnProcess(retire.cmd, retire.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    worker.unref()
    worker.once('error', () => {})
  }, deps.flushDelayMs ?? 50)
}
