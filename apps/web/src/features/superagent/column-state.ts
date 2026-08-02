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
/**
 * The feed read cursor USED to live here as `podium:superfeed:cursor`, a
 * device-local ui-state key. It is per-user state — read state follows the
 * person (`docs/multi-user-readiness.md` §3.3) — and POD-1380 moved it to the
 * `readPosition` family: `store.readPosition`, backed by `user_read_position` and
 * `readPosition.advance`. The note stays because a reader looking for the cursor
 * looks here first, and an absence explains nothing.
 */

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
