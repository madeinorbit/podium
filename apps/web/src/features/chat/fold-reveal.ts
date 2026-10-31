import type { ConversationPresentation } from './conversation-presentation'

interface RevealPorts {
  presentation: Pick<ConversationPresentation, 'openFoldAt' | 'anchorRow'>
  scroll: {
    releaseFollow: () => void
    scrollToBlock: (index: number, opts?: { instant?: boolean }) => void
  }
  frame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
}

/**
 * A minimap jump into a closed fold (POD-2285). Stop following the tail first,
 * so the transcript holds its window and the grown feed does not carry the
 * reader away; open the fold; give the work two frames to take its height;
 * then land on the row through the scroll controller. The row is carried by
 * its KEY, not its index: a delivery during the wait can move every index.
 *
 * Returns a cancel for the queued landing, or undefined when the row was not
 * folded. The caller owns it: a new jump, another session or an unmount
 * cancels it, so a landing never reaches a feed it was not asked for.
 */
export function revealFoldedRow(ports: RevealPorts, index: number): (() => void) | undefined {
  const { presentation, scroll } = ports
  const frame = ports.frame ?? requestAnimationFrame
  const cancelFrame = ports.cancelFrame ?? cancelAnimationFrame
  scroll.releaseFollow()
  const key = presentation.openFoldAt(index)
  if (key === undefined) return undefined
  let id = frame(() => {
    id = frame(() => {
      const at = presentation.anchorRow(key)
      if (at !== undefined) scroll.scrollToBlock(at, { instant: true })
    })
  })
  return () => cancelFrame(id)
}
