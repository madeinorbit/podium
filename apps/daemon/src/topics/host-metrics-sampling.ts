/**
 * HOST-METRICS SAMPLING ON THE DAEMON (ADR 7 Amendment 2 D22; POD-5800).
 *
 * Two modes, chosen per link:
 *
 * - **topics.v1 link:** the 5 s sampler runs only while the server holds a
 *   `topicWatch on` for `machine.metrics:<self>`. The server holds it for every
 *   viewer it has, its own pressure sweep included, so "nobody watching" really
 *   means nothing samples.
 * - **older link:** the pre-topics always-on timer, exactly as before. It is
 *   not a watch, so a link loss (which stops every watch) leaves it running, as
 *   it always did. POD-6680 removes it once every server speaks topics.
 *
 * Event-driven reports (connect, readiness changes, binding recovery) are NOT
 * this module's: they are changes the server must hear, sent by the host
 * runtime on their own, and they are not a sampler.
 */

import type { HostMetricsWire, MachineId } from '@podium/model'
import { topicKey } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { TopicWatchRegistry } from './watch-registry'

/** One sample, in the envelope this link speaks. */
export function hostMetricsFrame(
  machineId: MachineId,
  sample: HostMetricsWire,
  topicsAccepted: boolean,
): Extract<DaemonMessage, { type: 'topicPublish' | 'hostMetrics' }> {
  return topicsAccepted
    ? { type: 'topicPublish', key: topicKey('machine.metrics', machineId), payload: sample }
    : { type: 'hostMetrics', ...sample }
}

export interface HostMetricsSampling {
  /** A link came up. Demand starts empty; the always-on timer runs only on an older link. */
  linkUp(topicsAccepted: boolean): void
  close(): void
}

export function createHostMetricsSampling(deps: {
  readonly machineId: MachineId
  readonly intervalMs: number
  /** False disables the always-on timer (tests); demand-driven sampling still runs. */
  readonly background: boolean
  readonly watches: TopicWatchRegistry
  /** Take and send one sample now. */
  readonly push: () => void
}): HostMetricsSampling {
  let alwaysOn: ReturnType<typeof setInterval> | undefined
  const stopAlwaysOn = (): void => {
    if (alwaysOn) clearInterval(alwaysOn)
    alwaysOn = undefined
  }

  deps.watches.register('machine.metrics', (id) => {
    // A key for another machine is not this daemon's to sample.
    if (id !== deps.machineId) return () => {}
    deps.push()
    const timer = setInterval(deps.push, deps.intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  return {
    linkUp(topicsAccepted) {
      // A NEW LINK STARTS WITH NO DEMAND (D21/D22): the server re-sends
      // topicWatch for every key still held, so nothing keeps sampling for a
      // viewer that left while the link was down.
      deps.watches.reset()
      if (topicsAccepted) {
        stopAlwaysOn()
        return
      }
      if (!deps.background || alwaysOn) return
      alwaysOn = setInterval(deps.push, deps.intervalMs)
      alwaysOn.unref?.()
    },
    close() {
      stopAlwaysOn()
      deps.watches.reset()
    },
  }
}
