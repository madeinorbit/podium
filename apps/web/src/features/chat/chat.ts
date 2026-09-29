import type { ConversationBubble } from '@podium/client-core/conversation'
import type { ChatRow } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model/browser'

/**
 * Pure helpers for the chat view: transcript search and the birds-eye minimap
 * geometry. Rendering stays in ChatView.tsx. The presentation-pure tool-call
 * helpers (pairing, batching, verdicts) moved to @podium/client-core/viewmodels
 * so the mobile TranscriptList shares them (POD-176); re-exported here so web
 * call sites keep their import path.
 */
export {
  buildChatRows,
  type ChatBlock,
  type ChatRow,
  failLine,
  isBatchableTool,
  isInteractiveTool,
  mcpLabel,
  mcpParts,
  pairToolResults,
  resultPreview,
  type SingleRow,
  type ToolBatchRow,
  type ToolVerdict,
  toolBatchTitle,
  toolCallPhrase,
  toolRunElapsedMs,
  toolRunFailures,
  toolSubject,
  toolVerdict,
} from '@podium/client-core/viewmodels'

/**
 * Maximum number of transcript paths retained for terminal link matching.
 *
 * The transcript window can be paged much deeper than the rendered chat, and a
 * long-running session may mention an unbounded number of files. Keeping a
 * bounded recent index prevents path metadata from becoming a second, hidden
 * transcript. Keep more entries than the terminal's 5,000-line scrollback can
 * display so a path still visible in the buffer is not evicted merely because
 * the transcript mentioned more than 4,096 unique paths.
 */
export const FILE_LINK_PATH_CAP = 8_192

/**
 * Incrementally owns the path set consumed by the terminal file-link provider.
 *
 * `knownPaths` deliberately exposes a read-only view with stable identity. The
 * provider only performs membership/iteration reads, so handing it this set
 * avoids copying the full history for every transcript delta. Repeated paths
 * are moved to the newest end before the oldest entries are evicted.
 */
export class FileLinkPathIndex {
  private readonly paths = new Set<string>()

  constructor(private readonly cap = FILE_LINK_PATH_CAP) {
    if (!Number.isInteger(cap) || cap < 1)
      throw new RangeError('file-link path cap must be positive')
  }

  get knownPaths(): ReadonlySet<string> {
    return this.paths
  }

  reset(): void {
    this.paths.clear()
  }

  add(delta: readonly TranscriptItem[]): void {
    for (const item of delta) {
      for (const path of item.toolPaths ?? []) {
        if (path.length === 0) continue
        // Set insertion order is our cheap LRU: refreshing a path keeps a
        // frequently mentioned file alive while the cap is under pressure.
        this.paths.delete(path)
        this.paths.add(path)
      }
    }
    while (this.paths.size > this.cap) {
      const oldest = this.paths.values().next().value
      if (oldest === undefined) break
      this.paths.delete(oldest)
    }
  }
}

// Transcript SEARCH moved to the chat slice (`blockMatches` / `searchBlocks` in
// @podium/client-core/viewmodels): it is pure, it is the same question mobile
// asks, and the row that renders a hit is derived beside it, so the counter, the
// scroll jump and the dimming cannot disagree about what a match is.

/** DOM-measured position of one [data-block] child as ratios of scrollHeight. */
export interface BlockOffset {
  index: number
  /** offsetTop / scrollHeight */
  top: number
  /** offsetHeight / scrollHeight */
  height: number
}

/** One tick rendered in the minimap, positioned in the same linear scroll space
 *  as the viewport box and scrubTo. */
export interface MinimapTick {
  index: number
  role: TranscriptItem['role']
  answer: boolean
  /** Ratio of scroller.scrollHeight — pass directly to `top: X%`. */
  top: number
  /** Ratio of scroller.scrollHeight — pass directly to `height: X%`. */
  height: number
}

/**
 * Read the real DOM positions of every [data-block] child of `scroller` and
 * return them as ratios of scrollHeight so they live in the same coordinate
 * space as scrollTop/scrollHeight.
 */
export function measureBlockOffsets(scroller: HTMLElement): BlockOffset[] {
  const total = scroller.scrollHeight || 1
  const scrollerTop = scroller.getBoundingClientRect().top
  const offsets: BlockOffset[] = []
  const children = scroller.querySelectorAll<HTMLElement>('[data-block]')
  children.forEach((el) => {
    const indexAttr = el.getAttribute('data-block')
    if (indexAttr === null) return
    const index = Number(indexAttr)
    const top = (el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop) / total
    offsets.push({
      index,
      top,
      height: el.offsetHeight / total,
    })
  })
  return offsets
}

/** Minimap colour inputs for one rendered row. A tool batch reads as 'tool'
 *  (faint) regardless of how many calls it folds. */
export function rowTickMeta(row: ChatRow): { role: TranscriptItem['role']; answer: boolean } {
  if (row.kind === 'tools') return { role: 'tool', answer: false }
  return { role: row.block.item.role, answer: row.block.item.answer === true }
}

/**
 * Zip per-row metadata (role, answer) with DOM-measured offsets to produce ticks
 * for the minimap. Both arrays are indexed by ROW position (one tick per rendered
 * [data-block] row); entries with no matching offset are skipped.
 */
export function ticksFromOffsets(
  metas: Array<{ role: TranscriptItem['role']; answer: boolean }>,
  offsets: BlockOffset[],
): MinimapTick[] {
  const offsetByIndex = new Map<number, BlockOffset>()
  for (const o of offsets) offsetByIndex.set(o.index, o)
  const ticks: MinimapTick[] = []
  metas.forEach((m, i) => {
    const o = offsetByIndex.get(i)
    if (!o) return
    ticks.push({ index: i, role: m.role, answer: m.answer, top: o.top, height: o.height })
  })
  return ticks
}

/**
 * One "You" bubble below the transcript (POD-4764): this device's send until
 * the server's record of it arrives, then that record, by id. It leaves when
 * the history entry the record names is on screen — see `projectConversation`.
 */
export type PendingItem = ConversationBubble & {
  /** The whole caption of a failed send: "not sent — …" when it never reached
   *  the server (POD-4762), "not delivered …" when it failed after. */
  failure?: string
}
