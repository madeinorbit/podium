import type { HarnessObservation, HarnessObserveInput } from '../../manifest.js'

export interface CodexObservationAttachment {
  readonly pid: number
  holdsWriterLease?(): boolean
  onExit?(listener: () => void): (() => void) | undefined
  onLeaseLost?(listener: () => void): (() => void) | undefined
}

/** A Codex native observer may use only this live attachment's process generation. */
export function observeWithCodexProcessLease(
  harness: string,
  input: HarnessObserveInput,
  observe: (input: HarnessObserveInput) => HarnessObservation,
  session?: CodexObservationAttachment,
): HarnessObservation {
  if (!session || harness !== 'codex') return observe(input)
  let live = true
  const generation = {}
  const offExit = session?.onExit?.(() => {
    live = false
  })
  const offLease = session?.onLeaseLost?.(() => {
    live = false
  })
  const observation = observe({
    ...input,
    ...(session
      ? {
          ownedProcess: () =>
            live && session.pid > 0 && session.holdsWriterLease?.() === true
              ? { pid: session.pid, generation }
              : undefined,
        }
      : {}),
  })
  return {
    ...observation,
    stop() {
      live = false
      offExit?.()
      offLease?.()
      observation.stop()
    },
  }
}
