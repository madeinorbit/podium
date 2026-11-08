import type { MachineId } from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'
import { MachineProcessesWatchInput, topicKey } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { TopicWatchRegistry } from './watch-registry'

/** Only the server supplies roots, derived from this machine's registered repos.
 * Sampling is demand-driven and non-overlapping; a stopped read never publishes. */
export function registerProcessesWatch(deps: {
  machineId: MachineId
  watches: TopicWatchRegistry
  read: (roots: string[]) => Promise<HostMemoryBreakdown>
  send: (frame: DaemonMessage) => void
  onError?: (error: unknown) => void
}): void {
  deps.watches.register('machine.processes', (id, input) => {
    if (id !== deps.machineId) return () => {}
    const { roots } = MachineProcessesWatchInput.parse(input)
    let stopped = false
    let running = false
    const sample = async (): Promise<void> => {
      if (stopped || running) return
      running = true
      try {
        const payload = await deps.read(roots)
        if (!stopped)
          deps.send({ type: 'topicPublish', key: topicKey('machine.processes', id), payload })
      } catch (error) {
        if (!stopped) deps.onError?.(error)
      } finally {
        running = false
      }
    }
    void sample()
    const timer = setInterval(() => void sample(), 5_000)
    timer.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  })
}
