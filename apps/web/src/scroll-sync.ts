export interface BlockPos {
  line: number
  top: number
}

/** The preview scrollTop that brings the block for `line` to the top. */
export function topForLine(blocks: BlockPos[], line: number): number {
  let best = 0
  for (const b of blocks) {
    if (b.line <= line) best = b.top
    else break
  }
  return best
}

/** The source line for the topmost visible preview block at `scrollTop`. */
export function lineForTop(blocks: BlockPos[], scrollTop: number): number {
  let best = blocks[0]?.line ?? 1
  for (const b of blocks) {
    if (b.top <= scrollTop) best = b.line
    else break
  }
  return best
}
