/**
 * Turning a live quota reading into ledger samples.
 *
 * Pure, so the rules about what is worth recording are testable without a
 * database, a daemon, or a clock.
 */

import { type MachineQuotaWire, type QuotaSample, quotaAccountKey } from '@podium/model'

/**
 * `fetchedAt` IS THE OBSERVATION TIME, not `Date.now()`. The daemon memoises each
 * provider read for 120 seconds, so a reading can arrive up to that stale — and
 * it carries the timestamp of the fetch that actually produced it. Stamping these
 * samples with the server's clock would silently shift every point on the burn
 * curve forward by however long the memo held.
 */
export function samplesFromQuota(machines: MachineQuotaWire[]): QuotaSample[] {
  const out: QuotaSample[] = []
  for (const machine of machines) {
    for (const agent of machine.agents) {
      // Only a healthy read describes the account's real capacity. An
      // `unauthenticated` / `expired` / `error` agent reports no windows worth
      // trusting, and writing a 0% row for one would draw a wasted window that
      // never happened.
      if (agent.status !== 'ok') continue
      const atMs = Date.parse(agent.fetchedAt)
      if (!Number.isFinite(atMs)) continue
      const accountKey = quotaAccountKey(agent.agent, agent.account?.email, machine.machineId)
      for (const window of agent.windows) {
        // `resetsAt: ''` is a legitimate value meaning "the provider did not say".
        // Without it there is no way to tell which run of the window this is, so
        // the sample cannot join a series and is dropped rather than guessed at.
        const resetsAtMs = Date.parse(window.resetsAt)
        if (!Number.isFinite(resetsAtMs)) continue
        if (!Number.isFinite(window.usedPercent)) continue
        out.push({
          accountKey,
          agent: agent.agent,
          windowKey: window.key,
          label: window.label,
          scopeModel: window.scopeModel,
          plan: agent.account?.plan,
          usedPercent: window.usedPercent,
          resetsAtMs,
          windowMinutes: window.windowMinutes,
          atMs,
          source: 'live',
        })
      }
    }
  }
  return out
}
