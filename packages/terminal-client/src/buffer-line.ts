export interface CellLike {
  getChars(): string
  getWidth(): number
  isBold(): boolean
  isUnderline(): boolean
  getFgColor(): number
  getFgColorMode(): number
}
export interface LineLike {
  length: number
  isWrapped: boolean
  getCell(x: number, cell?: unknown): CellLike | undefined
}
export interface BufferLike {
  getLine(y: number): LineLike | undefined
}

export interface Cell {
  char: string
  x: number
  y: number
  styled: boolean
}

function cellStyled(c: CellLike): boolean {
  // Default fg in xterm is mode 0 (DEFAULT). Any explicit colour, bold, or
  // underline counts as "highlighted".
  return c.getFgColorMode() !== 0 || c.isBold() || c.isUnderline()
}

/** Build the full logical line containing `anyRow`: walk back to the first row
 *  whose successor chain reaches anyRow (i.e. the first non-wrapped row), then
 *  forward through wrapped continuations. Each emitted cell keeps its real
 *  buffer coordinate so matches map back to the grid. */
export function stitchLogicalLine(buf: BufferLike, anyRow: number): Cell[] {
  let start = anyRow
  while (start > 0) {
    const line = buf.getLine(start)
    if (!line?.isWrapped) break
    start -= 1
  }
  const out: Cell[] = []
  for (let y = start; ; y += 1) {
    const line = buf.getLine(y)
    if (!line) break
    if (y !== start && !line.isWrapped) break
    for (let x = 0; x < line.length; x += 1) {
      const c = line.getCell(x)
      if (!c) continue
      if (c.getWidth() === 0) continue // spacer half of a wide glyph
      const char = c.getChars() || ' '
      out.push({ char, x, y, styled: cellStyled(c) })
    }
  }
  return out
}
