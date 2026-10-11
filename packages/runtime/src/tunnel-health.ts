/** Transient reports from the local tunnel supervisor; no credentials or persisted state. */
import { z } from 'zod'

export const TunnelHealthReport = z.object({
  state: z.enum(['starting', 'working', 'unhealthy', 'restarting', 'stopped']),
  url: z.string().url().max(512).nullable(),
  lastOkAt: z.number().int().nonnegative().nullable(),
  failedSince: z.number().int().nonnegative().nullable(),
  lastError: z.string().max(1024).nullable(),
})
export type TunnelHealthReport = z.infer<typeof TunnelHealthReport>
export type TunnelHealth = TunnelHealthReport & { reportedAt: number }
export const TUNNEL_REPORT_MAX_AGE_MS = 90_000
