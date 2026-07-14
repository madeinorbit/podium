/**
 * Persisted state of the engraved column's two sections (engraved-column.md
 * §2.7 / handoff 3b): Tray and Super agent each collapse to their compact
 * header bar, never further, each independently persisted. The #40 shell owns
 * the whole-column open|folded|closed mode (`podium:superagent:mode`); these
 * keys are the CONTENT's per-section state inside the open column.
 */

export const TRAY_OPEN_KEY = 'podium:tray:open'
export const SUPER_CHAT_OPEN_KEY = 'podium:superagent:chat'
/** Tray body height (px) set by the tray/chat split handle (every section is
 *  resizable — .design/decisions.md). Absent = size to content. */
export const TRAY_HEIGHT_KEY = 'podium:tray:height'
/** Feed read cursor: the last issue-event id seen with the chat visible, plus
 *  the ISO time it was set — the YOU WERE HERE divider and the collapsed-✦
 *  unread dot both derive from it. */
export const FEED_CURSOR_KEY = 'podium:superfeed:cursor'

export function readSectionOpen(value: string | null): boolean {
  return value !== 'false' && value !== '0'
}

export const TRAY_MIN_HEIGHT = 52
export const TRAY_MAX_HEIGHT_RATIO = 0.6

export function readTrayHeight(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= TRAY_MIN_HEIGHT ? Math.round(n) : null
}

export interface FeedCursor {
  /** Highest event id acknowledged as seen; 0 = never seen the feed. */
  id: number
  /** When the cursor was last advanced (drives the divider's clock label). */
  ts: string | null
}

export function readFeedCursor(value: string | null): FeedCursor {
  if (value) {
    try {
      const parsed = JSON.parse(value) as { id?: unknown; ts?: unknown }
      if (typeof parsed.id === 'number' && Number.isFinite(parsed.id) && parsed.id >= 0) {
        return { id: Math.floor(parsed.id), ts: typeof parsed.ts === 'string' ? parsed.ts : null }
      }
    } catch {
      // fall through — corrupt value reads as "never seen"
    }
  }
  return { id: 0, ts: null }
}

export function writeFeedCursor(cursor: FeedCursor): string {
  return JSON.stringify(cursor)
}
