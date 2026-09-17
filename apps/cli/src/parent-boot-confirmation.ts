import type { MachineUpdateExecutor } from '@podium/runtime/machine-update'
import type { ParentProcess } from '@podium/runtime/parent-process'

/** Keep initial startup and eventual recovery wired to the same exact-identity gate. */
export async function startParentWithUpdateConfirmation(
  parent: ParentProcess,
  updates: MachineUpdateExecutor,
  afterStart: () => Promise<void> = async () => {},
): Promise<void> {
  let started = false
  let confirmation: Promise<void> | undefined
  const confirmHealthy = (signal: AbortSignal): Promise<void> =>
    (confirmation ??= (async () => {
      if (signal.aborted) return
      // Publish only after the health gate, but before resuming native work.
      await afterStart()
      if (!signal.aborted) await updates.confirmBoot(true, signal)
    })())
  await parent.start((signal) => {
    if (started) return confirmHealthy(signal)
  })
  if (parent.bootHealthSignal.aborted) return
  started = true
  if (parent.isBootHealthy()) await confirmHealthy(parent.bootHealthSignal)
  else await updates.confirmBoot(false, parent.bootHealthSignal)
  // A committed activation stays fenced until the later health callback proves it.
}
