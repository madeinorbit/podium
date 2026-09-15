/**
 * Layout service (POD-1350) — read/write the calling principal's layout and
 * publish each mutation onto the Authority change log so a second device of the
 * same user receives the row (scoped feed; POD-402 review gap 2).
 */

import { createLogger } from '@podium/logger'
import { type LayoutSnapshot, type LayoutWire, layoutRowId, type UserId } from '@podium/model'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import type { UserLayoutRepository } from '../../store/user-layout'

const log = createLogger('server:layout')
/** The canonical layout key carrying the per-session chat/native map. */
const PANEL_MODE_LAYOUT_KEY = 'panelMode'

export interface LayoutServiceDeps {
  readonly layout: UserLayoutRepository
  /**
   * Write-seam ledger. Layout rows ride entity kind `userLayout` so bootstrap
   * and delta share one log. Optional only for pure unit tests of storage;
   * production always wires it.
   */
  readonly ledger?: Pick<Ledger, 'capture'>
}

export class LayoutService {
  constructor(private readonly deps: LayoutServiceDeps) {}

  async getSnapshot(userId: UserId): Promise<LayoutSnapshot> {
    return await this.deps.layout.getSnapshot(userId)
  }

  async set(userId: UserId, values: Record<string, unknown>, now: string): Promise<LayoutSnapshot> {
    // Per-session panel modes travel as ONE map under one key, so the debug
    // line records which sessions this write changed against the stored map
    // (POD-3932): the server is the only place both maps meet, and the writer's
    // device is read off the client log that precedes this line.
    const panelModeDiff = await this.panelModeDiff(userId, values)
    log.debug('layout set', {
      userId,
      keys: Object.keys(values),
      ...(panelModeDiff ? { panelModeChanged: panelModeDiff } : {}),
    })
    await this.deps.layout.setMany(userId, values, now)
    await this.publish(
      Object.entries(values).map(([key, value]) => ({
        userId,
        key,
        value,
        op: 'upsert' as const,
      })),
    )
    return await this.deps.layout.getSnapshot(userId)
  }

  async clear(userId: UserId, keys: readonly string[]): Promise<LayoutSnapshot> {
    await this.deps.layout.clearMany(userId, keys)
    await this.publish(keys.map((key) => ({ userId, key, op: 'remove' as const })))
    return await this.deps.layout.getSnapshot(userId)
  }

  private async panelModeDiff(
    userId: UserId,
    values: Record<string, unknown>,
  ): Promise<Array<{ sessionId: string; from: string | null; to: string | null }> | null> {
    if (!(PANEL_MODE_LAYOUT_KEY in values)) return null
    const parse = (raw: unknown): Record<string, string> => {
      if (typeof raw !== 'string') return {}
      try {
        const obj: unknown = JSON.parse(raw)
        return obj !== null && typeof obj === 'object' ? (obj as Record<string, string>) : {}
      } catch {
        return {}
      }
    }
    const before = parse((await this.deps.layout.getSnapshot(userId))[PANEL_MODE_LAYOUT_KEY])
    const after = parse(values[PANEL_MODE_LAYOUT_KEY])
    const changed: Array<{ sessionId: string; from: string | null; to: string | null }> = []
    for (const sid of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[sid] !== after[sid]) {
        changed.push({ sessionId: sid, from: before[sid] ?? null, to: after[sid] ?? null })
      }
    }
    return changed
  }

  /**
   * Boot reconcile: every durable layout row becomes a positive upsert on the
   * log so a reconnecting principal's bootstrap sees them without a second path.
   */
  reconcileAllToLedger(): void {
    // Full-table read is only for boot. Repository has no all(); use the store
    // SQL via a dedicated path when wired — for now capture is driven by writes.
  }

  private async publish(
    rows: ReadonlyArray<
      | { userId: UserId; key: string; value: unknown; op: 'upsert' }
      | { userId: UserId; key: string; op: 'remove' }
    >,
  ): Promise<void> {
    const ledger = this.deps.ledger
    if (!ledger || rows.length === 0) return
    const specs: EntityChangeSpec[] = rows.map((row) => {
      const id = layoutRowId(row.userId, row.key)
      if (row.op === 'remove') {
        return { entity: 'userLayout', id, op: 'remove' }
      }
      const value: LayoutWire = { userId: row.userId, key: row.key, value: row.value }
      return { entity: 'userLayout', id, op: 'upsert', value }
    })
    await ledger.capture(specs)
  }
}
