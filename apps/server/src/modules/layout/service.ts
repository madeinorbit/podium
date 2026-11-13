/**
 * Layout service (POD-1350) — read/write the calling principal's layout and
 * publish each mutation onto the Authority change log so a second device of the
 * same user receives the row (scoped feed; POD-402 review gap 2).
 *
 * ONE COMMIT PER WRITE (ADR 12 D9, POD-6594). A set or a clear is one
 * `commit` on the writer of the command that asked for it: the rows are written
 * in its `write`, with the commit's scope, and the Authority appends a change
 * entry for each layout record the write changed, from the database's change
 * capture (POD-6920). The writer comes from the sync handler,
 * per call; the service holds none of its own.
 */

import { createLogger } from '@podium/logger'
import { type LayoutSnapshot, layoutRowId, type UserId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'

/** What a layout write is made through: the command's own writer. */
export type LayoutCommandWriter = Pick<LedgerWriter, 'commit'>

import type { UserLayoutRepository } from '../../store/user-layout'

const log = createLogger('server:layout')
/** The canonical layout key carrying the per-session chat/native map. */
const PANEL_MODE_LAYOUT_KEY = 'panelMode'

export interface LayoutServiceDeps {
  readonly layout: UserLayoutRepository
}

export class LayoutService {
  constructor(private readonly deps: LayoutServiceDeps) {}

  async getSnapshot(userId: UserId): Promise<LayoutSnapshot> {
    return await this.deps.layout.getSnapshot(userId)
  }

  async set(
    writer: LayoutCommandWriter,
    userId: UserId,
    values: Record<string, unknown>,
    now: string,
  ): Promise<LayoutSnapshot> {
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
    await writer.commit({
      write: async (scope) => await this.deps.layout.setMany(scope, userId, values, now),
    })
    return await this.deps.layout.getSnapshot(userId)
  }

  async clear(
    writer: LayoutCommandWriter,
    userId: UserId,
    keys: readonly string[],
  ): Promise<LayoutSnapshot> {
    await writer.commit({
      write: async (scope) => await this.deps.layout.clearMany(scope, userId, keys),
    })
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
}
