/**
 * SEEDING THE LEDGER FROM WHAT THE HARNESSES ALREADY WROTE DOWN.
 *
 * Runs once per boot, in the background, after the fleet has had a chance to
 * connect. Recovered samples go through the SAME fold as live ones — that is the
 * point of sharing the identity rule — so a window that backfill reached and live
 * sampling later catches up with converges on one row rather than two.
 *
 * IT IS ALSO THE IDENTITY RULE'S REAL TEST. The measured Codex corpus holds 77
 * distinct `resets_at` instants across a span that can only contain about six
 * true weekly windows, because the provider's reset time jitters on every read.
 * If the tolerant fold works, those 77 collapse to ~6 rows; if it does not, the
 * ledger draws 77 columns and the bug is immediately visible.
 */

import { createLogger } from '@podium/logger'
import { type QuotaSample, quotaAccountKey, type UserId } from '@podium/model'
import type { QuotaHistorySampleWire } from '@podium/protocol'
import type { QuotaHistoryRepository } from '../../store/quota-history'
import { QUOTA_HISTORY_RETENTION_MS, QUOTA_SAMPLE_INTERVAL_MS, type QuotaOwnerOf } from './service'

const log = createLogger('server:quota-history')

/** Let daemons connect before asking them to walk their disks. */
export const QUOTA_BACKFILL_BOOT_DELAY_MS = 60 * 1000

export function toQuotaSample(wire: QuotaHistorySampleWire): QuotaSample | undefined {
  if (!Number.isFinite(wire.usedPercent)) return undefined
  if (!Number.isFinite(wire.resetsAtMs) || !Number.isFinite(wire.atMs)) return undefined
  return {
    accountKey: quotaAccountKey(wire.agent, wire.email, wire.machineId),
    agent: wire.agent,
    windowKey: wire.windowKey,
    label: wire.label,
    plan: wire.plan,
    usedPercent: wire.usedPercent,
    resetsAtMs: wire.resetsAtMs,
    windowMinutes: wire.windowMinutes,
    atMs: wire.atMs,
    source: 'backfill',
  }
}

/**
 * Fold recovered samples in observation order.
 *
 * ORDER IS LOAD-BEARING HERE in a way it is not for live sampling. The importer
 * walks files, not the clock, so samples arrive shuffled across sessions; folding
 * them as they came would open and close windows in the wrong sequence. Sorting
 * by `atMs` first replays the real history.
 */
export async function ingestBackfill(
  history: QuotaHistoryRepository,
  wires: QuotaHistorySampleWire[],
  intervalMs: number = QUOTA_SAMPLE_INTERVAL_MS,
  ownerOf: QuotaOwnerOf = async () => null,
): Promise<{ recorded: number; skipped: number }> {
  // A recovered window belongs to the custodian of the machine whose files it
  // came from, as a live one does (POD-6300).
  const owners = new Map<string, UserId | null>()
  for (const wire of wires) {
    if (!owners.has(wire.machineId)) {
      owners.set(wire.machineId, await ownerOf(wire.machineId).catch(() => null))
    }
  }
  const samples = wires
    .map((wire) => ({ sample: toQuotaSample(wire), machineId: wire.machineId }))
    .filter((s): s is { sample: QuotaSample; machineId: string } => s.sample !== undefined)
    .sort((a, b) => a.sample.atMs - b.sample.atMs)
  let recorded = 0
  for (const { sample, machineId } of samples) {
    try {
      await history.record(sample, intervalMs, owners.get(machineId) ?? null)
      recorded += 1
    } catch (err) {
      log.debug('backfill sample not recorded', { err })
    }
  }
  return { recorded, skipped: wires.length - recorded }
}

export interface QuotaBackfillOptions {
  /** Whose a recovered window is: the reporting machine's custodian. */
  ownerOf?: QuotaOwnerOf
  bootDelayMs?: number
  retentionMs?: number
  now?: () => number
}

/**
 * One-shot boot backfill.
 *
 * Unconditional rather than gated on "have we done this before": the fold is
 * idempotent, so a repeat re-derives the same rows, and the alternative — a
 * durable "already backfilled" flag — would mean a machine that came online
 * after the first run never got imported at all.
 */
export class QuotaBackfill {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  private readonly bootDelayMs: number
  private readonly retentionMs: number
  private readonly now: () => number
  private readonly ownerOf: QuotaOwnerOf | undefined

  constructor(
    private readonly history: QuotaHistoryRepository,
    private readonly readHistory: (sinceMs: number) => Promise<QuotaHistorySampleWire[]>,
    options: QuotaBackfillOptions = {},
  ) {
    this.bootDelayMs = options.bootDelayMs ?? QUOTA_BACKFILL_BOOT_DELAY_MS
    this.ownerOf = options.ownerOf
    this.retentionMs = options.retentionMs ?? QUOTA_HISTORY_RETENTION_MS
    this.now = options.now ?? Date.now
  }

  start(): void {
    this.timer = setTimeout(() => void this.runOnce(), this.bootDelayMs)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
  }

  async runOnce(): Promise<{ recorded: number; skipped: number }> {
    if (this.disposed) return { recorded: 0, skipped: 0 }
    // Nothing older than retention: importing rows the pruner deletes on its next
    // pass is work done twice to reach the same state.
    const sinceMs = this.now() - this.retentionMs
    let wires: QuotaHistorySampleWire[]
    try {
      wires = await this.readHistory(sinceMs)
    } catch (err) {
      log.debug('quota backfill failed', { err })
      return { recorded: 0, skipped: 0 }
    }
    if (this.disposed || wires.length === 0) return { recorded: 0, skipped: 0 }
    const result = await ingestBackfill(this.history, wires, QUOTA_SAMPLE_INTERVAL_MS, this.ownerOf)
    log.info('quota history backfilled', {
      samples: wires.length,
      recorded: result.recorded,
      windows: await this.history.countAll(),
    })
    return result
  }
}
