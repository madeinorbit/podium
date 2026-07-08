/**
 * Presentation-pure helpers for the chat surface, shared between the web
 * ChatView and (where the same concept applies) mobile: composer text
 * building, duration/elapsed formatting, and machine-authored context block
 * recognition. Nothing here touches the DOM — the web-only, DOM-dependent
 * chat helpers (block pairing, minimap geometry, …) stay in apps/web/src/chat.ts.
 */

/** Build the path-prefixed prompt: image paths prepended newline-separated, then the user text. */
export function buildImagePrompt(paths: string[], text: string): string {
  if (paths.length === 0) return text
  return `${paths.join('\n')}\n${text}`
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i
/** Does this path look like an image we can render inline? */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path)
}

/** "Churned for …" duration, Claude-style: "2s", "18m 24s", "1h 3m". */
export function formatChurn(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Live elapsed since an ISO instant, coarse: "5s", "4m 12s", "1h 6m". */
export function formatElapsed(sinceMs: number, nowMs: number): string {
  return formatChurn(Math.max(0, nowMs - sinceMs))
}

/**
 * Returns true when incoming transcript items represent a reset that should
 * force the scroll position back to the bottom (new session load, reconnect
 * snapshot, or Codex session-switch that sends a fresh snapshot).
 */
export function shouldPinOnReset(isReset: boolean, pinnedToBottom: boolean): boolean {
  // A reset always re-pins: the user's scroll offset into the old data is
  // meaningless once the list has been replaced with a fresh snapshot.
  // Incremental appends respect the current pin state (user may have scrolled up).
  return isReset || pinnedToBottom
}

/** Machine-authored superagent context blocks (seed / re-entry delta), matched
 *  by their leading marker — collapsed into a quiet disclosure row instead of
 *  a giant "You" bubble. */
export const MACHINE_CONTEXT_RE = /^\[(BTW|CONCIERGE) (CONTEXT|UPDATE)/

/** Label for a collapsed machine-context row: repo vs session, context vs update. */
export function machineContextLabel(text: string): string {
  const what = text.startsWith('[CONCIERGE') ? 'repo' : 'session'
  const kind = /^\[(BTW|CONCIERGE) UPDATE/.test(text) ? 'update' : 'context'
  return `${what} ${kind}`
}
