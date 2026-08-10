import type { IssueStage } from '@podium/model'
import { anyRefMatcher } from '@podium/protocol'
import type { BufferLike, Cell } from './buffer-line'
import { findRefMatches, rowCells } from './ref-link-provider'

/**
 * Persistent (glanceable) marking of ref tokens in the terminal (#517, POD-529).
 *
 * xterm link decorations only appear on hover, so tokens like `POD-441` are
 * invisible affordances until the mouse happens to cross them. This layer draws
 * a stage-tinted pill with an underline (matching the chat `.ref-link` chip
 * language) behind every known-prefix ref in the CURRENT VIEWPORT, so mentions
 * stand out at a glance and issue workflow state is visible without inserting
 * glyphs into the fixed cell buffer.
 *
 * Mechanism: an absolutely-positioned, pointer-events-none div appended into
 * `.xterm-screen` (position: relative, sized exactly cols×cellW / rows×cellH by
 * xterm's renderer, for both the WebGL and DOM renderers). Underline rects are
 * positioned in cell coordinates: cell size = screen rect ÷ grid. Recomputes are
 * requestAnimationFrame-coalesced off onRender/onScroll/onResize, rows without a
 * ref candidate bail on a single translateToString + regex test, and underline
 * divs are pooled (hidden, not destroyed) so steady streaming does not churn DOM.
 */

/** Accent colours aligned with chat `a.ref-link--issue[data-issue-stage=…]`. */
export const REF_STAGE_ACCENT: Readonly<Record<IssueStage, string>> = {
  proposed: 'rgb(217, 70, 239)',
  backlog: 'color-mix(in srgb, var(--muted-foreground, #94a3b8) 70%, transparent)',
  planning: 'var(--muted-foreground, #94a3b8)',
  // Blue, not amber: POD-583 reserved amber for operator attention and moved
  // every in-progress stage signal onto this channel. Terminals were the third
  // surface and were missed then — a ref underlined here must read the same as
  // the React StageGlyph and the markdown `.ref-link` chip.
  in_progress: 'rgb(59, 130, 246)',
  review: 'rgb(14, 165, 233)',
  done: 'var(--success, #22c55e)',
}

const DEFAULT_REF_ACCENT = 'var(--primary, #D97757)'

/** CSS colour for a ref decoration; unknown/session refs keep the default accent. */
export function refStageAccent(stage: IssueStage | null | undefined): string {
  return stage ? REF_STAGE_ACCENT[stage] : DEFAULT_REF_ACCENT
}

export interface MentionRect {
  left: number
  top: number
  width: number
  height: number
  /** The matched token text (e.g. `POD-13`). */
  ref: string
  /** Live workflow stage for issue refs; null for session/unresolved. */
  stage: IssueStage | null
}

/** Buffer surface the overlay needs: rows + where the viewport starts. */
export interface ViewportBufferLike extends BufferLike {
  viewportY: number
}

/**
 * Pure geometry: one rect per known-prefix ref across the viewport rows.
 * `rows[r]` holds the cells of VIEWPORT row r; each cell's `x` is its real
 * buffer column (wide glyphs earlier in the row already accounted for). Rects
 * span the full cell height — the caller draws only their bottom border.
 */
export function mentionRects(
  rows: Cell[][],
  isKnownPrefix: (prefix: string) => boolean,
  cellWidth: number,
  cellHeight: number,
  resolveStage?: (ref: string) => IssueStage | null | undefined,
): MentionRect[] {
  const out: MentionRect[] = []
  for (let r = 0; r < rows.length; r += 1) {
    const cells = rows[r]
    if (!cells || cells.length === 0) continue
    for (const m of findRefMatches(cells, isKnownPrefix)) {
      const first = m.cells[0]
      const last = m.cells[m.cells.length - 1]
      if (!first || !last) continue
      out.push({
        left: first.x * cellWidth,
        top: r * cellHeight,
        width: (last.x - first.x + 1) * cellWidth,
        height: cellHeight,
        ref: m.ref,
        stage: resolveStage?.(m.ref) ?? null,
      })
    }
  }
  return out
}

export interface RefUnderlineOverlayHooks {
  /** The `.xterm-screen` element the underline layer is appended into. */
  screen: HTMLElement
  getBuffer: () => ViewportBufferLike
  getCols: () => number
  getRows: () => number
  /** null = ref links unconfigured; the layer stays empty. */
  getIsKnownPrefix: () => ((prefix: string) => boolean) | null
  /** Optional live stage for issue refs (POD-529). Session/unknown omit. */
  getResolveStage?: () => ((ref: string) => IssueStage | null | undefined) | null | undefined
}

export class RefUnderlineOverlay {
  private readonly hooks: RefUnderlineOverlayHooks
  private readonly layer: HTMLElement
  private readonly pool: HTMLElement[] = []
  private rafId: number | null = null
  private disposed = false

  constructor(hooks: RefUnderlineOverlayHooks) {
    this.hooks = hooks
    const doc = hooks.screen.ownerDocument
    this.layer = doc.createElement('div')
    this.layer.className = 'podium-ref-underlines'
    // z-index 3: above the render canvas / .xterm-rows (z auto), below xterm's
    // decoration container (z 6-7) and any hover tooltip.
    this.layer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3'
    hooks.screen.appendChild(this.layer)
  }

  /** rAF-coalesced refresh — safe to call on every render/scroll/resize tick. */
  schedule(): void {
    if (this.disposed || this.rafId !== null) return
    const raf: (cb: () => void) => number =
      typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => setTimeout(cb, 16) as unknown as number
    this.rafId = raf(() => {
      this.rafId = null
      this.refreshNow()
    })
  }

  /** Recompute and reposition every underline for the current viewport. */
  refreshNow(): void {
    if (this.disposed) return
    const isKnown = this.hooks.getIsKnownPrefix()
    if (!isKnown) {
      this.showRects([])
      return
    }
    const rect = this.hooks.screen.getBoundingClientRect()
    const cols = this.hooks.getCols()
    const rows = this.hooks.getRows()
    if (rect.width <= 0 || rect.height <= 0 || cols < 1 || rows < 1) {
      this.showRects([])
      return
    }
    const buf = this.hooks.getBuffer()
    const viewportY = buf.viewportY
    const matcher = anyRefMatcher()
    const rowsCells: Cell[][] = []
    for (let r = 0; r < rows; r += 1) {
      const line = buf.getLine(viewportY + r)
      if (!line) {
        rowsCells.push([])
        continue
      }
      // Cheap bail: most rows carry no ref-shaped token at all. One string +
      // one regex test per row avoids building per-cell objects every frame.
      const quick = line.translateToString?.(true)
      if (quick !== undefined) {
        matcher.lastIndex = 0
        if (!matcher.test(quick)) {
          rowsCells.push([])
          continue
        }
      }
      rowsCells.push(rowCells(buf, viewportY + r))
    }
    const resolveStage = this.hooks.getResolveStage?.() ?? undefined
    this.showRects(mentionRects(rowsCells, isKnown, rect.width / cols, rect.height / rows, resolveStage))
  }

  private showRects(rects: MentionRect[]): void {
    const doc = this.layer.ownerDocument
    while (this.pool.length < rects.length) {
      const el = doc.createElement('div')
      // Geometry only at create time; stage colour/style is applied per paint so
      // pooled nodes can move between stages without recreation.
      // Deliberately no dotted border for the default path — WebKit (Tauri) and
      // Chromium rasterize 1px dots differently at fractional cell widths.
      el.style.cssText = 'position:absolute;box-sizing:border-box;border-radius:3px'
      this.layer.appendChild(el)
      this.pool.push(el)
    }
    for (let i = 0; i < this.pool.length; i += 1) {
      const el = this.pool[i]
      if (!el) continue
      const r = rects[i]
      if (!r) {
        if (el.style.display !== 'none') el.style.display = 'none'
        continue
      }
      const accent = refStageAccent(r.stage)
      // Backlog uses a dashed underline (matches the dashed StageGlyph); other
      // stages keep a solid hairline so colour is the primary stage signal.
      const borderStyle = r.stage === 'backlog' ? 'dashed' : 'solid'
      el.style.display = 'block'
      el.style.left = `${r.left}px`
      el.style.top = `${r.top}px`
      el.style.width = `${r.width}px`
      el.style.height = `${r.height}px`
      // Stage colour lives on --ref-accent so paint and tests share one source;
      // color-mix against it matches the chat chip language in real browsers.
      el.style.setProperty('--ref-accent', accent)
      el.style.backgroundColor = 'color-mix(in srgb, var(--ref-accent) 12%, transparent)'
      el.style.borderBottomWidth = '1px'
      el.style.borderBottomStyle = borderStyle
      el.style.borderBottomColor = 'color-mix(in srgb, var(--ref-accent) 65%, transparent)'
      el.dataset.ref = r.ref
      if (r.stage) el.dataset.issueStage = r.stage
      else delete el.dataset.issueStage
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId)
      else clearTimeout(this.rafId)
      this.rafId = null
    }
    this.layer.remove()
    this.pool.length = 0
  }
}
