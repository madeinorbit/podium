/**
 * The store the usage sheet reads, replaced by three canned answers (POD-1861).
 *
 * `UsageView` takes exactly one thing off the store — the tRPC client — and asks
 * it three questions: the hour buckets, the quota window history, and the
 * per-task cost rows. Everything else on the sheet is derived, so a stub this
 * small is enough to mount the WHOLE surface and check the claim no
 * section-in-isolation harness can: that every region ends on ONE right edge.
 */

import type { UsageBucketWire } from '@podium/model'
import { TASK_ROWS } from './usage-tasks-fixture'

const HOUR_MS = 3_600_000

/** A week with a plausible shape: overnight runs, quiet hours, a busy peak. */
function buckets(): UsageBucketWire[] {
  const now = Date.now()
  const out: UsageBucketWire[] = []
  for (let h = 0; h < 7 * 24; h++) {
    const at = now - h * HOUR_MS
    const hourOfDay = new Date(at).getHours()
    // Quiet between 02:00 and 07:00, heaviest late afternoon.
    if (hourOfDay >= 2 && hourOfDay < 7 && h % 3 !== 0) continue
    const weight = 0.3 + Math.abs(Math.sin((hourOfDay / 24) * Math.PI * 2)) * 1.7
    const scale = weight * (1 + ((h * 37) % 11) / 11)
    out.push({
      hour: new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString(),
      model: h % 5 === 0 ? 'claude-fable-5' : h % 3 === 0 ? 'gpt-5.6-sol' : 'claude-opus-5',
      inputTokens: Math.round(90_000 * scale),
      outputTokens: Math.round(26_000 * scale),
      cacheReadTokens: Math.round(5_400_000 * scale),
      cacheCreationTokens: Math.round(240_000 * scale),
      messages: Math.round(22 * scale),
    })
  }
  return out
}

const BUCKETS = buckets()

export function useStoreSelector<T>(select: (s: Record<string, unknown>) => T): T {
  return select({
    trpc: {
      usage: {
        summary: {
          query: async () => ({
            hostname: 'harness',
            sampledAt: new Date().toISOString(),
            buckets: BUCKETS,
          }),
        },
      },
      quota: { history: { query: async () => [] } },
      cost: { tasks: { query: async () => TASK_ROWS } },
    },
  })
}
