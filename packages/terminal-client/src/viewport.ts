export interface ViewportSize {
  width: number
  height: number
  dpr: number
}

export interface CellSize {
  width: number
  height: number
}

export interface Grid {
  cols: number
  rows: number
}

/** Floor a pixel viewport by cell size into a terminal grid (at least 1x1). */
export function computeGrid(px: { width: number; height: number }, cell: CellSize): Grid {
  const cols = Math.max(1, Math.floor(px.width / cell.width))
  const rows = Math.max(1, Math.floor(px.height / cell.height))
  return { cols, rows }
}

/**
 * The seam between the host viewport and the terminal grid. Production wraps
 * `visualViewport` (Phase 3b); this injectable impl drives it deterministically in
 * tests — including the soft-keyboard inset that no headless browser fires faithfully.
 */
export interface ViewportSource {
  current(): ViewportSize
  onChange(cb: (size: ViewportSize) => void): () => void
  dispose(): void
}

export class InjectableViewportSource implements ViewportSource {
  private size: ViewportSize
  private baseHeight: number
  private readonly cbs = new Set<(size: ViewportSize) => void>()

  constructor(initial: ViewportSize) {
    this.size = { ...initial }
    this.baseHeight = initial.height
  }

  current(): ViewportSize {
    return { ...this.size }
  }

  onChange(cb: (size: ViewportSize) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  setSize(width: number, height: number): void {
    this.size = { ...this.size, width, height }
    this.baseHeight = height
    this.emit()
  }

  /** Reproduce a soft keyboard taking `inset` px off the bottom (0 = keyboard closed). */
  simulateKeyboard(inset: number): void {
    this.size = { ...this.size, height: this.baseHeight - inset }
    this.emit()
  }

  dispose(): void {
    this.cbs.clear()
  }

  private emit(): void {
    for (const cb of [...this.cbs]) cb(this.current())
  }
}
